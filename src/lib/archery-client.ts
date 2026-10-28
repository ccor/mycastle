// archery-client.ts — minimal fetch-based Archery client.
// Read paths (query/browse) plus workflow-ticket helpers (sqlcheck / submit / detail).
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
  instance: string; // instance name as shown in the Archery UI
  db: string;
  sql: string;
  table?: string;
  limit?: number; // limit_num, default 100
}

// --- response-shape interfaces (loose: fields optional + index signature, Archery versions differ) ---
// Confirmed shapes from test real-runs.

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
  instance_name?: string;
  [key: string]: unknown;
}

/** Permission tags Archery filters instances by (tag_codes[]). */
export type InstanceTag = "can_read" | "can_execute" | "can_audit" | "can_modify";

export const INSTANCE_TAGS: readonly InstanceTag[] = ["can_read", "can_execute", "can_audit", "can_modify"];

// --- workflow (upline ticket) types ---

export interface WorkflowSqlCheckOpts {
  instanceId: number;
  db: string;
  fullSql: string;
}

export interface WorkflowSubmitOpts {
  name: string; // workflow_name
  groupId: number; // group id (see workflow.groups())
  instanceId: number;
  db: string;
  sql: string;
  demandUrl?: string;
  isBackup?: boolean;
  runDateStart?: string; // YYYY-MM-DD (empty = asap)
  runDateEnd?: string;
}

export interface WorkflowGroup {
  id: number;
  name: string;
}

/** One audited statement row (sqlcheck rows / detail_content rows share this shape). */
export interface SqlCheckRow {
  id: number;
  stage: string; // "CHECKED"
  errlevel: number; // 0=ok 1=warning 2=error
  stagestatus: string; // "Audit Completed" / ...
  errormessage: string;
  sql: string;
  affected_rows: number;
  sequence: string;
  backup_dbname: string;
  execute_time: string;
  sqlsha1: string;
  backup_time: string;
  actual_affected_rows: string;
  [key: string]: unknown;
}

/** POST /api/v1/workflow/sqlcheck/ response. checked==="True" && error_count===0 => clean. */
export interface SqlCheckResult {
  checked?: string | boolean;
  error?: string | null;
  warning?: string | null;
  error_count?: number;
  warning_count?: number;
  is_critical?: boolean;
  syntax_type?: number;
  rows?: SqlCheckRow[];
  [key: string]: unknown;
}

/** POST /api/v1/workflow/ response — creates the ticket in workflow_manreviewing. */
export interface WorkflowSubmitResult {
  id: number; // review-info id
  workflow_id: number; // ticket id (the number in /detail/<id>/ URLs)
  workflow?: {
    id: number;
    workflow_name?: string;
    status?: string; // e.g. workflow_manreviewing
    group_name?: string;
    db_name?: string;
    engineer_display?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** GET /sqlworkflow/detail_content/?workflow_id=N response. */
export interface WorkflowDetailContent {
  rows: SqlCheckRow[];
  [key: string]: unknown;
}

/** Probe result of a classic form endpoint (/execute/ / /cancel/): the server
 *  answers with a 302 to the detail page (HTML), never JSON, so we return
 *  transport-level facts and let the caller verify via workflow content/list. */
export interface WorkflowActionProbe {
  httpStatus: number;
  finalUrl: string;
  looksLikeLoginPage: boolean;
  title: string;
  [key: string]: unknown;
}

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

/**
 * Parse the group dropdown from the /submitsql/ page HTML.
 * Page shape (Archery bootstrap-select): <select id="group_name" ...> with options
 *   <option value="<code>" group-id="<id>"><name></option> — the numeric id lives in
 * the group-id attribute, not in value. Scoped to that one select so unrelated
 * <option> elements (auth type, backup, JS templates) are ignored.
 */
export function parseGroupOptions(html: string): WorkflowGroup[] {
  const selMatch = html.match(/<select[^>]*id="group_name"[^>]*>([\s\S]*?)<\/select>/i);
  const seg = selMatch?.[1] ?? "";
  const out: WorkflowGroup[] = [];
  for (const m of seg.matchAll(/<option[^>]*group-id="(\d+)"[^>]*>([\s\S]*?)<\/option>/g)) {
    const id = Number(m[1]);
    const name = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
    if (Number.isFinite(id) && name) out.push({ id, name });
  }
  return out;
}

/**
 * Split a SQL script into statements on top-level `;` (quote-aware: ' " `
 * with backslash and doubled-quote escapes). Trims each, drops empties.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "\\") {
        cur += sql[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === inStr) {
        if (sql[i + 1] === inStr) {
          cur += sql[i + 1]!;
          i++;
        } else {
          inStr = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Statements Archery tickets reject: txn control (Archery manages its own
 * transaction) and SET NAMES (it sets the session charset itself).
 */
const NON_TICKET_RE = /^(BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|ROLLBACK\b|SET\s+NAMES\b)/i;

/** Drop txn-control / SET NAMES statements while PRESERVING comments: each
 *  returned element is one ticket-safe statement prefixed with its preceding
 *  `--`/`#` comment lines and ending with `;` (trailing file comments attach
 *  after the last kept statement). A dropped txn statement's comments carry
 *  over to the next kept statement, so file-header comments survive.
 *  Comments are stripped from the sniffed text first: a ';' inside a comment
 *  (common in Chinese prose headers) would otherwise split statements. */
export function stripNonTicketStatements(sql: string): string[] {
  const kept: string[] = [];
  let comments: string[] = [];
  let body = "";
  let inStr: string | null = null;

  const flush = (): void => {
    const bare = body.trim();
    if (!bare) return;
    if (NON_TICKET_RE.test(bare)) {
      body = ""; // drop the statement; its pending comments carry over
      return;
    }
    kept.push([...(comments.length > 0 ? [...comments, ""] : []), bare + ";"].join("\n"));
    comments = [];
    body = "";
  };

  for (const line of sql.split("\n")) {
    if (inStr === null && /^\s*(--|#)/.test(line)) {
      const c = line.trim();
      if (c) comments.push(c);
      continue;
    }
    let acc = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inStr) {
        acc += ch;
        if (ch === "\\") {
          acc += line[i + 1] ?? "";
          i++;
          continue;
        }
        if (ch === inStr) {
          if (line[i + 1] === inStr) {
            acc += line[i + 1]!;
            i++;
          } else {
            inStr = null;
          }
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        inStr = ch;
        acc += ch;
        continue;
      }
      if (ch === ";") {
        body += acc;
        flush();
        acc = "";
        continue;
      }
      acc += ch;
    }
    body += (body ? "\n" : "") + acc;
  }
  flush();
  if (comments.length > 0) {
    const tail = comments.join("\n");
    if (kept.length > 0) kept[kept.length - 1] += "\n" + tail;
    else kept.push(tail);
  }
  return kept;
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

  /** Form request (parsed JSON, or raw text if not JSON). Re-logins once on expiry. */
  async request<T = unknown>(
    method: string,
    p: string,
    form?: Record<string, string>,
  ): Promise<T> {
    return this.sendRaw<T>(method, p, () => this.doFetch(method, p, form, "follow"), true);
  }

  /** JSON-body request (Archery /api/v1/* endpoints take application/json). */
  async requestJson<T = unknown>(method: string, p: string, json: unknown): Promise<T> {
    return this.sendRaw<T>(
      method,
      p,
      () => this.doFetch(method, p, undefined, "follow", undefined, json),
      true,
    );
  }

  /** Fetch a server-rendered HTML page as raw text.
   *  Skips the isLoginPage auto-relogin: any Django form page (e.g. /submitsql/)
   *  contains "csrfmiddlewaretoken" and would be misread as a login page. */
  async page(method: string, p: string): Promise<string> {
    await this.ensureSession();
    const res = await this.doFetch(method, p, undefined, "follow");
    return res.text();
  }

  /** POST a classic Django form endpoint (/execute/, /cancel/): the server 302s
   *  back to the detail page, so the answer is HTML — return transport-level
   *  facts; caller verifies the outcome via workflow content / list.
   *  Uses manual redirect: a 302 to /login/ means expired session (retry after
   *  re-login); a 302 to /detail/N/ means success. Never sniff HTML for the
   *  login page here — the detail page itself contains csrf form tokens and
   *  would be misread. */
  private async postFormPage(
    p: string,
    form: Record<string, string>,
    allowRelogin = true,
  ): Promise<WorkflowActionProbe> {
    const res = await this.doFetch("POST", p, form, "manual");
    const loc = res.headers.get("location") ?? "";
    const finalUrl = loc
      ? new URL(loc, this.baseUrl).toString()
      : (res.url || buildUrl(this.baseUrl, p));
    const isLoginRedirect = /\/login\/?(\?|$)/.test(finalUrl);
    if (allowRelogin && isLoginRedirect) {
      await this.login();
      return this.postFormPage(p, form, false);
    }
    const redirectedToDetail = /\/detail\/\d+\/?$/.test(finalUrl);
    let title = "";
    if (!loc) {
      const text = await res.text();
      title = text.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
    }
    return {
      httpStatus: res.status,
      finalUrl,
      redirectedToDetail,
      looksLikeLoginPage: isLoginRedirect,
      title,
    };
  }

  private async sendRaw<T>(
    method: string,
    p: string,
    doReq: () => Promise<Response>,
    allowRelogin: boolean,
  ): Promise<T> {
    const res = await doReq();
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
      return this.sendRaw<T>(method, p, doReq, false);
    }
    if (!allowRelogin && isLoginPage(body)) {
      throw new ArcheryApiError(401, body, buildUrl(this.baseUrl, p), this.env);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ArcheryApiError(res.status, body, buildUrl(this.baseUrl, p), this.env);
    }
    return body as T;
  }

  /** Low-level fetch: headers, form/JSON body, cookies+CSRF, timeout, redirect mode. */
  protected async doFetch(
    method: string,
    p: string,
    form: Record<string, string> | undefined,
    redirect: Redirect,
    csrfOverride?: string,
    jsonBody?: unknown,
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
    if (jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(jsonBody);
    } else if (form) {
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
    // The submit page's group dropdown is the group source that page itself
    // uses; parse <option ... group-id="N">name</option> from it.
    groups: async (): Promise<WorkflowGroup[]> => {
      const html = await this.page("GET", "/submitsql/");
      return parseGroupOptions(html);
    },
    // Server-side audit (inception-resolver style check). No ticket is created.
    sqlcheck: async (opts: WorkflowSqlCheckOpts): Promise<SqlCheckResult> => {
      await this.ensureSession();
      return this.requestJson<SqlCheckResult>("POST", "/api/v1/workflow/sqlcheck/", {
        full_sql: opts.fullSql,
        instance_id: String(opts.instanceId),
        db_name: opts.db,
      });
    },
    // Create an upline ticket (status workflow_manreviewing). Does NOT execute SQL —
    // execution still requires the usual review/approve/execute flow on the platform.
    submit: async (opts: WorkflowSubmitOpts): Promise<WorkflowSubmitResult> => {
      await this.ensureSession();
      return this.requestJson<WorkflowSubmitResult>("POST", "/api/v1/workflow/", {
        workflow: {
          workflow_name: opts.name,
          demand_url: opts.demandUrl ?? "",
          group_id: String(opts.groupId),
          instance: String(opts.instanceId),
          db_name: opts.db,
          is_backup: opts.isBackup ?? false,
          run_date_start: opts.runDateStart ?? "",
          run_date_end: opts.runDateEnd ?? "",
        },
        sql_content: opts.sql,
      });
    },
    // Audited statements of an existing ticket (the SQL exactly as it would run).
    detailContent: async (workflowId: number): Promise<WorkflowDetailContent> => {
      await this.ensureSession();
      const params = new URLSearchParams({ workflow_id: String(workflowId) });
      return this.request<WorkflowDetailContent>(
        "GET",
        `/sqlworkflow/detail_content/?${params.toString()}`,
      );
    },
    // Execute a ticket now (the "立即执行" form on the detail page:
    // POST /execute/ {mode=auto|manual, workflow_id}). Runs the audited SQL.
    execute: async (workflowId: number, mode: "auto" | "manual" = "auto"): Promise<WorkflowActionProbe> => {
      await this.ensureSession();
      return this.postFormPage("/execute/", { mode, workflow_id: String(workflowId) });
    },
    // Cancel a pending ticket (the "终止流程" form: POST /cancel/ {workflow_id, cancel_remark}).
    cancel: async (workflowId: number, remark = ""): Promise<WorkflowActionProbe> => {
      await this.ensureSession();
      return this.postFormPage("/cancel/", {
        workflow_id: String(workflowId),
        cancel_remark: remark,
      });
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
    // array with status != 0 and an empty data object.
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
