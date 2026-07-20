// archery-client.ts — minimal fetch-based Archery client (read-only data side).
// Session = Django { sessionid, csrftoken }, persisted per env via archery-session.js.

import { clearSession, readSession, writeSession } from "./archery-session.js";

export class ArcheryApiError extends Error {
  readonly status: number; // HTTP status; 0 for transport/timeout
  readonly body: unknown; // parsed JSON if possible, else raw text
  readonly url: string;
  readonly env: string;
  constructor(status: number, body: unknown, url: string, env: string) {
    super(`Archery API ${status} at ${url} [env=${env}]`);
    this.name = "ArcheryApiError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.env = env;
  }
}

// --- option types ---

export interface WorkflowListOpts {
  status?: string; // navStatus (English key, e.g. workflow_finish — NOT a Chinese label)
  instanceId?: number; // instance_id
  groupId?: number; // group_id
  fromDate?: string; // start_date YYYY-MM-DD
  toDate?: string; // end_date
  search?: string;
  limit?: number;
  offset?: number;
}

export interface QuerylogListOpts {
  limit?: number;
  offset?: number;
  search?: string;
}

export interface QueryRunOpts {
  instance: string; // Chinese instance name
  db: string;
  sql: string;
  table?: string;
  limit?: number; // limit_num, default 100
}

// --- response-shape interfaces (loose: fields optional + index signature, Archery versions differ) ---

/** Family A — `{status, msg, data}` envelope (instance/* endpoints). status=0 means ok. */
export interface ArcheryEnvelope<T = unknown> {
  status: number;
  msg: string;
  data: T;
  [key: string]: unknown;
}

/** `data` sub-object of an ArcheryQueryStep / instance.describe (Family A / A′ inner). */
export interface ArcheryDescribeData {
  full_sql?: string;
  rows?: unknown[][];
  column_list?: string[];
  column_type?: string[];
  query_time?: number | string;
  error?: string | null;
  affected_rows?: number;
  is_execute?: boolean;
  is_masked?: boolean;
  mask_rule_hit?: boolean;
  warning?: unknown;
  is_critical?: boolean;
  checked?: unknown;
  mask_time?: string;
  [key: string]: unknown;
}

/** Family A′ — one execution "step" returned by /query/ (the endpoint returns a list of these). */
export interface ArcheryQueryStep {
  status: number; // 0 = ok; non-zero = MySQL error (msg holds it)
  msg: string;
  data: ArcheryDescribeData; // {} on failure
  [key: string]: unknown;
}

/** Family B — `{total, rows}` paginated envelope (workflow.list / querylog.list). */
export interface ArcheryPage<T = unknown> {
  total: number;
  rows: T[];
  [key: string]: unknown;
}

/** Row of workflow.list (Family B `rows` element). All optional except id; plus index signature. */
export interface WorkflowRow {
  id: number;
  workflow_name?: string;
  engineer_display?: string;
  status?: string; // English key, e.g. workflow_finish
  is_backup?: boolean;
  create_time?: string;
  instance__instance_name?: string;
  db_name?: string;
  group_name?: string;
  syntax_type?: number;
  is_export?: number;
  [key: string]: unknown;
}

/** Row of querylog.list (Family B `rows` element). All optional except id; plus index signature. */
export interface QuerylogRow {
  id: number;
  instance_name?: string;
  db_name?: string;
  sqllog?: string;
  effect_row?: number;
  cost_time?: string;
  user_display?: string;
  favorite?: boolean;
  alias?: string;
  create_time?: string;
  [key: string]: unknown;
}

/** Row of instances.list (/group/user_all_instances/, Family A `data` element).
 *  This is the "instances the current user can access" view (the SQL-query dropdown
 *  source), NOT the full admin inventory — gated by the account's group permissions. */
export interface InstanceRow {
  id: number;
  type?: string; // e.g. "master" / "slave"
  db_type?: string; // e.g. "mysql" / "mongo"
  instance_name?: string; // Chinese instance name
  [key: string]: unknown;
}

/** Permission tags Archery filters instances by (tag_codes[]). */
export type InstanceTag = "can_read" | "can_execute" | "can_audit" | "can_modify";

export const INSTANCE_TAGS: readonly InstanceTag[] = ["can_read", "can_execute", "can_audit", "can_modify"];

// --- helpers ---------------------------------------------------------------

function buildUrl(baseUrl: string, p: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const tail = p.replace(/^\/+/, "");
  return `${base}/${tail}`;
}

/** Extract a cookie value from a list of Set-Cookie header strings. */
export function cookieFromSetCookies(setCookies: string[], name: string): string | undefined {
  for (const sc of setCookies) {
    const pair = sc.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k === name) {
      const v = pair.slice(eq + 1).trim();
      if (v.length > 0) return v;
    }
  }
  return undefined;
}

const LOGIN_PAGE_MARKERS = ['name="username"', "csrfmiddlewaretoken"];

/** Heuristic: does this response body look like the login page (session expired)? */
export function isLoginPage(body: unknown): boolean {
  if (typeof body !== "string") return false;
  return LOGIN_PAGE_MARKERS.some((m) => body.includes(m));
}

// --- client ----------------------------------------------------------------

export interface ArcheryClientOptions {
  env: string;
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number; // default 30000
}

type Redirect = "follow" | "manual" | "error";

export class ArcheryClient {
  readonly env: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  private sessionid: string | undefined;
  private csrftoken: string | undefined;

  constructor(opts: ArcheryClientOptions) {
    this.env = opts.env;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.username = opts.username;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  // --- session tokens ---

  /** Load persisted tokens into memory; returns true if a session is available. */
  loadSession(): boolean {
    const rec = readSession(this.env);
    this.sessionid = rec?.sessionid;
    this.csrftoken = rec?.csrftoken;
    return !!this.sessionid && !!this.csrftoken;
  }

  /** Ensure we have tokens; login (fresh) if none is persisted. */
  async ensureSession(): Promise<void> {
    if (!this.loadSession()) await this.login();
  }

  // --- auth ---

  /** Three-step Django login and persist {sessionid, csrftoken}. Throws on failure. */
  async login(): Promise<void> {
    // 1. GET /login/ to seed the csrftoken cookie (manual redirect to read Set-Cookie).
    const loginPage = await this.doFetch("GET", "/login/", undefined, "manual");
    const seedCsrf = cookieFromSetCookies(loginPage.headers.getSetCookie(), "csrftoken");
    if (!seedCsrf) {
      throw new Error(`Login failed for env="${this.env}": no csrftoken from GET /login/.`);
    }
    // 2. POST /authenticate/ with X-CSRFTOKEN header == csrftoken cookie (double-submit).
    const authRes = await this.doFetch(
      "POST",
      "/authenticate/",
      { username: this.username, password: this.password },
      "manual",
      seedCsrf,
    );
    const setCookies = authRes.headers.getSetCookie();
    const sessionid = cookieFromSetCookies(setCookies, "sessionid");
    const csrftoken = cookieFromSetCookies(setCookies, "csrftoken") ?? seedCsrf;
    // 3. Accept only if we got a sessionid.
    if (!sessionid) {
      this.sessionid = undefined;
      this.csrftoken = undefined;
      const body = await authRes.text().catch(() => "");
      throw new Error(
        `Login failed for env="${this.env}" user="${this.username}" (no sessionid). ` +
          `Status=${authRes.status} body=${body.slice(0, 200)}`,
      );
    }
    this.acceptSession(sessionid, csrftoken);
  }

  /** Persist freshly obtained tokens. */
  private acceptSession(sessionid: string, csrftoken: string): void {
    this.sessionid = sessionid;
    this.csrftoken = csrftoken;
    writeSession(this.env, sessionid, csrftoken);
  }

  /** Clear the persisted session (best-effort); also tries GET /logout/. */
  async logout(): Promise<void> {
    try {
      await this.doFetch("GET", "/logout/", undefined, "follow").catch(() => undefined);
    } finally {
      this.sessionid = undefined;
      this.csrftoken = undefined;
      clearSession(this.env);
    }
  }

  /** Probe: is the current session usable? Never throws — returns {ok, env}. */
  async status(): Promise<{ ok: boolean; env: string }> {
    try {
      await this.ensureSession();
      await this.request("GET", "/query/querylog/?limit=1");
      return { ok: true, env: this.env };
    } catch {
      return { ok: false, env: this.env };
    }
  }

  // --- HTTP core ---

  /** Form/GET request (parsed JSON, or raw text if not JSON). Re-logins once on expiry. */
  async request<T = unknown>(
    method: string,
    p: string,
    form?: Record<string, string>,
  ): Promise<T> {
    return this.send<T>(method, p, form, true);
  }

  private async send<T>(
    method: string,
    p: string,
    form: Record<string, string> | undefined,
    allowRelogin: boolean,
  ): Promise<T> {
    const res = await this.doFetch(method, p, form, "follow");
    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text (e.g. HTML pages) */
      }
    }
    if (allowRelogin && isLoginPage(body)) {
      await this.login();
      return this.send<T>(method, p, form, false);
    }
    if (!allowRelogin && isLoginPage(body)) {
      throw new ArcheryApiError(401, body, buildUrl(this.baseUrl, p), this.env);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ArcheryApiError(res.status, body, buildUrl(this.baseUrl, p), this.env);
    }
    return body as T;
  }

  /** Low-level fetch: headers, form body, cookies+CSRF, timeout, redirect mode. */
  protected async doFetch(
    method: string,
    p: string,
    form: Record<string, string> | undefined,
    redirect: Redirect,
    csrfOverride?: string,
  ): Promise<Response> {
    const url = buildUrl(this.baseUrl, p);
    const headers: Record<string, string> = {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${this.baseUrl}/sqlquery/`,
    };
    const csrf = csrfOverride ?? this.csrftoken;
    if (csrf) headers["X-CSRFTOKEN"] = csrf;
    const cookieParts: string[] = [];
    if (this.csrftoken) cookieParts.push(`csrftoken=${this.csrftoken}`);
    if (this.sessionid) cookieParts.push(`sessionid=${this.sessionid}`);
    // Login step 2: send the seed csrf as cookie too (double-submit), since the
    // authenticated sessionid isn't set yet.
    if (csrfOverride && csrfOverride !== this.csrftoken) {
      cookieParts.push(`csrftoken=${csrfOverride}`);
    }
    if (cookieParts.length > 0) headers.Cookie = cookieParts.join("; ");
    const init: RequestInit = { method, headers, redirect };
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      init.body = new URLSearchParams(form).toString();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new ArcheryApiError(0, null, `timeout after ${this.timeoutMs}ms: ${url}`, this.env);
      }
      throw new ArcheryApiError(0, e instanceof Error ? e.message : String(e), url, this.env);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- resources ---

  readonly workflow = {
    list: async (opts?: WorkflowListOpts): Promise<ArcheryPage<WorkflowRow>> => {
      await this.ensureSession();
      const form: Record<string, string> = {
        limit: String(opts?.limit ?? 14),
        offset: String(opts?.offset ?? 0),
        navStatus: opts?.status ?? "",
        instance_id: opts?.instanceId !== undefined ? String(opts.instanceId) : "",
        group_id: opts?.groupId !== undefined ? String(opts.groupId) : "",
        start_date: opts?.fromDate ?? "",
        end_date: opts?.toDate ?? "",
        search: opts?.search ?? "",
      };
      return this.request<ArcheryPage<WorkflowRow>>("POST", "/sqlworkflow_list/", form);
    },
  };

  readonly querylog = {
    list: async (opts?: QuerylogListOpts): Promise<ArcheryPage<QuerylogRow>> => {
      await this.ensureSession();
      const params = new URLSearchParams({
        star: "",
        query_log_id: "",
        limit: String(opts?.limit ?? 14),
        offset: String(opts?.offset ?? 0),
        search: opts?.search ?? "",
        _: String(Date.now()),
      });
      return this.request<ArcheryPage<QuerylogRow>>("GET", `/query/querylog/?${params.toString()}`);
    },
  };

  readonly instances = {
    // GET /group/user_all_instances/?tag_codes[]=<tag> — instances the current user
    // can access for the given permission tag (the SQL-query dropdown source). NOT the
    // full admin inventory — gated by the account's group perms; a read-only/auditor
    // account typically sees all instances under can_read and none under the others.
    // Family A: {status, msg, data:[InstanceRow]}.
    list: async (tag: InstanceTag = "can_read"): Promise<ArcheryEnvelope<InstanceRow[]>> => {
      await this.ensureSession();
      const params = new URLSearchParams({ "tag_codes[]": tag });
      return this.request<ArcheryEnvelope<InstanceRow[]>>(
        "GET",
        `/group/user_all_instances/?${params.toString()}`,
      );
    },
  };

  readonly instance = {
    databases: async (name: string): Promise<ArcheryEnvelope<string[]>> => {
      await this.ensureSession();
      const params = new URLSearchParams({ instance_name: name, resource_type: "database" });
      return this.request<ArcheryEnvelope<string[]>>(
        "GET",
        `/instance/instance_resource/?${params.toString()}`,
      );
    },
    tables: async (name: string, db: string): Promise<ArcheryEnvelope<string[]>> => {
      await this.ensureSession();
      const params = new URLSearchParams({
        instance_name: name, db_name: db, resource_type: "table",
      });
      return this.request<ArcheryEnvelope<string[]>>(
        "GET",
        `/instance/instance_resource/?${params.toString()}`,
      );
    },
    columns: async (name: string, db: string, table: string): Promise<ArcheryEnvelope<string[]>> => {
      await this.ensureSession();
      const params = new URLSearchParams({
        instance_name: name, db_name: db, schema_name: "", tb_name: table, resource_type: "column",
      });
      return this.request<ArcheryEnvelope<string[]>>(
        "GET",
        `/instance/instance_resource/?${params.toString()}`,
      );
    },
    describe: async (
      name: string,
      db: string,
      table: string,
    ): Promise<ArcheryEnvelope<ArcheryDescribeData>> => {
      await this.ensureSession();
      return this.request<ArcheryEnvelope<ArcheryDescribeData>>("POST", "/instance/describetable/", {
        instance_name: name, db_name: db, schema_name: "", tb_name: table,
      });
    },
  };

  readonly query = {
    // NOTE: /query/ returns an ARRAY of execution "steps" (normally one element),
    // each step being the {status,msg,data} envelope. A failed query is a one-element
    // array with status != 0 and an empty data object. See spec §9.2.
    run: async (opts: QueryRunOpts): Promise<ArcheryQueryStep[]> => {
      await this.ensureSession();
      return this.request<ArcheryQueryStep[]>("POST", "/query/", {
        instance_name: opts.instance,
        db_name: opts.db,
        schema_name: "",
        tb_name: opts.table ?? "",
        sql_content: opts.sql,
        limit_num: String(opts.limit ?? 100),
      });
    },
  };
}
