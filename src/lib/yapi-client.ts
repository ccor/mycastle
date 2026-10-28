// yapi-client.ts — minimal fetch-based YApi client, dual auth:
//   token mode   — per-project openapi token passed as a query param (stateless).
//   session mode — POST /api/user/login -> cookies _yapi_token (JWT, 7d) +
//                  _yapi_uid; persisted per env; auto-relogin on expiry.
// Verified against YApi source (server/controllers/base.js: checkLogin runs for
// every route, so the same endpoints serve session and token access).
// Endpoints: https://hellosean1025.github.io/yapi/openapi.html (live-checked 2026-10).

import { clearSession, readSession, writeSession } from "./yapi-session.js";

export type YapiClientAuth =
  | { mode: "token"; projectId: string; token: string }
  | { mode: "session"; username: string; password: string; projectId?: string };

export class YapiApiError extends Error {
  /** YApi business code (body.errcode); 40011 = 请登录 (no/expired session or bad token). */
  readonly errcode: number;
  readonly errmsg: string;
  /** HTTP status; 0 for transport/timeout. YApi returns 200 even for business errors. */
  readonly status: number;
  readonly url: string;
  readonly env: string;
  constructor(errcode: number, errmsg: string, status: number, url: string, env: string) {
    const hint = errcode === 40011 && errmsg.includes("请登录")
      ? " (not logged in / token invalid)"
      : "";
    super(`YApi API errcode=${errcode} "${errmsg}"${hint} at ${url} [env=${env}]`);
    this.name = "YapiApiError";
    this.errcode = errcode;
    this.errmsg = errmsg;
    this.status = status;
    this.url = url;
    this.env = env;
  }
}

// --- response shapes (loose; unknown fields preserved) ---

export interface YapiProject {
  _id: number;
  name?: string;
  basepath?: string;
  group_id?: number;
  desc?: string;
  [key: string]: unknown;
}

export interface YapiGroup {
  _id: number;
  group_name?: string;
  [key: string]: unknown;
}

export interface YapiInterfaceSummary {
  _id: number;
  project_id?: number;
  catid?: number;
  title?: string;
  path?: string;
  method?: string;
  uid?: number;
  add_time?: number;
  up_time?: number;
  status?: string;
  edit_uid?: number;
  [key: string]: unknown;
}

export interface YapiInterface extends YapiInterfaceSummary {
  req_body_type?: string;
  req_body_other?: string;
  res_body?: string;
  res_body_type?: string;
  desc?: string;
  markdown?: string;
  [key: string]: unknown;
}

export interface YapiCategory {
  _id: number;
  name?: string;
  desc?: string;
  /** Full interface docs when --full / list_menu; summaries after summarizeCategories(). */
  list?: YapiInterfaceSummary[];
  [key: string]: unknown;
}

export interface YapiSnapshot {
  env: string;
  url: string;
  authMode: "token" | "session";
  projectId: string;
  takenAt: string;
  project: YapiProject;
  /** Categories with summarized interface lists (details live in `interfaces`). */
  categories: YapiCategory[];
  /** Full detail of every interface in the project. */
  interfaces: YapiInterface[];
}

export interface YapiStatus {
  ok: boolean;
  env: string;
  mode: "token" | "session";
  projectId?: string;
  projectName?: string;
  username?: string;
  login?: boolean;
  error?: string;
}

/** Keep only the light listing fields of an interface (drop res_body/desc bulk). */
export function summarizeInterface(it: YapiInterfaceSummary): YapiInterfaceSummary {
  return {
    _id: it._id,
    project_id: it.project_id,
    catid: it.catid,
    title: it.title,
    path: it.path,
    method: it.method,
    status: it.status,
    add_time: it.add_time,
    up_time: it.up_time,
  };
}

/** Categories with each interface list summarized. */
export function summarizeCategories(cats: YapiCategory[]): YapiCategory[] {
  return cats.map((c) => ({ ...c, list: (c.list ?? []).map(summarizeInterface) }));
}

/** Normalize a list endpoint's `data` to an array (YApi returns array or {list}). */
function dataToList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as { list?: unknown }).list)) {
    return (data as { list: unknown[] }).list;
  }
  return [];
}

/** mapLimit — run an async mapper over items with bounded concurrency, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** All Set-Cookie headers as individual "name=value; attrs" strings. */
function setCookieList(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const joined = res.headers.get("set-cookie");
  return joined ? [joined] : [];
}

// --- client ----------------------------------------------------------------

export interface YapiClientOptions {
  env: string;
  baseUrl: string;
  auth: YapiClientAuth;
  timeoutMs?: number; // default 30000
}

export class YapiClient {
  readonly env: string;
  readonly baseUrl: string;
  readonly auth: YapiClientAuth;
  readonly timeoutMs: number;
  private cookie: string | undefined;

  constructor(opts: YapiClientOptions) {
    this.env = opts.env;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.auth = opts.auth;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  get projectId(): string | undefined {
    return this.auth.projectId;
  }

  /** Project id guaranteed — project-scoped endpoints need it. */
  private requireProjectId(where: string): string {
    const pid = this.auth.projectId;
    if (pid === undefined || pid.length === 0) {
      throw new Error(`${where} requires a project id (pass it as <pid> or --project <id>).`);
    }
    return pid;
  }

  // --- session (login mode only) ---

  private isSession(): boolean {
    return this.auth.mode === "session";
  }

  /** Load persisted cookies into memory; returns true if available. */
  loadSession(): boolean {
    if (!this.isSession()) return false;
    const rec = readSession(this.env);
    this.cookie = rec?.cookie;
    return !!this.cookie;
  }

  /** Ensure we have cookies; login (fresh) if none is persisted. */
  async ensureSession(): Promise<void> {
    if (!this.isSession()) return;
    if (!this.loadSession()) await this.login();
  }

  /**
   * Login with email+password (form-encoded) and persist the cookie pair.
   * YApi sets _yapi_token (JWT, 7 days) + _yapi_uid on success.
   */
  async login(): Promise<void> {
    if (!this.isSession() || this.auth.mode !== "session") {
      throw new Error("login applies to session-mode envs (configure username/password).");
    }
    const url = `${this.baseUrl}/api/user/login`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          email: this.auth.username,
          password: this.auth.password,
        }).toString(),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new YapiApiError(-1, `timeout after ${this.timeoutMs}ms`, 0, url, this.env);
      }
      throw new YapiApiError(-1, e instanceof Error ? e.message : String(e), 0, url, this.env);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    const envelope = body as { errcode?: number; errmsg?: string };
    if (
      (res.status < 200 || res.status >= 300) ||
      (typeof envelope?.errcode === "number" && envelope.errcode !== 0)
    ) {
      this.cookie = undefined;
      clearSession(this.env);
      const code = typeof envelope?.errcode === "number" ? envelope.errcode : res.status;
      throw new YapiApiError(code, String(envelope?.errmsg ?? ""), res.status, url, this.env);
    }

    const pairs = setCookieList(res)
      .map((sc) => {
        const end = sc.indexOf(";");
        const pair = end >= 0 ? sc.slice(0, end) : sc;
        return pair.trim();
      })
      .filter((p) => p.length > 0 && !p.endsWith("=")); // skip cleared/empty cookies
    if (pairs.length === 0) {
      throw new YapiApiError(-1, "login succeeded but no session cookie was set", res.status, url, this.env);
    }
    this.cookie = pairs.join("; ");
    writeSession(this.env, this.cookie);
  }

  /** Logout on the server and clear the persisted cookie (best-effort). */
  async logout(): Promise<void> {
    if (!this.isSession()) {
      throw new Error("logout applies to session-mode envs (configure username/password).");
    }
    try {
      await this.request("/api/user/logout");
    } finally {
      this.cookie = undefined;
      clearSession(this.env);
    }
  }

  // --- HTTP core ---

  /**
   * Send one request (+token in token mode, +Cookie in session mode) and unwrap
   * the {errcode, errmsg, data} envelope. Session mode re-logins once on expiry.
   * POST bodies are JSON (YApi's web UI sends JSON too).
   */
  private async send<T = unknown>(
    method: "GET" | "POST",
    p: string,
    opts: {
      query?: Record<string, string | number>;
      body?: Record<string, unknown>;
      relogin?: boolean;
    } = {},
  ): Promise<T> {
    const relogin = opts.relogin ?? true;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) qs.set(k, String(v));
    if (this.auth.mode === "token") qs.set("token", this.auth.token);
    const url = `${this.baseUrl}/${p.replace(/^\/+/, "")}?${qs.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.cookie) headers.Cookie = this.cookie;
      let payload: string | undefined;
      if (method === "POST") {
        headers["Content-Type"] = "application/json; charset=UTF-8";
        payload = JSON.stringify(opts.body ?? {});
      }
      res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new YapiApiError(-1, `timeout after ${this.timeoutMs}ms`, 0, url, this.env);
      }
      throw new YapiApiError(-1, e instanceof Error ? e.message : String(e), 0, url, this.env);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text (proxy/HTML error pages) */
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const e0 = (body as { errcode?: unknown } | undefined)?.errcode ?? res.status;
      const m0 = (body as { errmsg?: unknown } | undefined)?.errmsg ?? String(body).slice(0, 200);
      throw new YapiApiError(Number(e0), String(m0), res.status, url, this.env);
    }
    const envelope = body as { errcode?: number; errmsg?: string; data?: T };
    const errcode = envelope?.errcode;
    if (typeof errcode === "number" && errcode !== 0) {
      // Session expired -> login once and retry. NOTE: YApi also uses errcode
      // 40011 for generic server errors ("服务器出错..."), so key off the message.
      if (
        this.isSession() && relogin &&
        errcode === 40011 && String(envelope?.errmsg ?? "").includes("请登录")
      ) {
        await this.login();
        return this.send<T>(method, p, { ...opts, relogin: false });
      }
      throw new YapiApiError(errcode, String(envelope?.errmsg ?? ""), res.status, url, this.env);
    }
    return envelope.data as T;
  }

  /** GET <path>?<query> (+token in token mode, +Cookie in session mode). */
  async request<T = unknown>(
    p: string,
    query?: Record<string, string | number>,
    relogin = true,
  ): Promise<T> {
    return this.send<T>("GET", p, { query, relogin });
  }

  /** POST <path> with a JSON body (+token in token mode, +Cookie in session mode). */
  async requestPost<T = unknown>(
    p: string,
    body: Record<string, unknown>,
    relogin = true,
  ): Promise<T> {
    return this.send<T>("POST", p, { body, relogin });
  }

  // --- read endpoints ---

  /** GET /api/project/get — project basic info. */
  async project(): Promise<YapiProject> {
    return this.request<YapiProject>("/api/project/get", { id: this.requireProjectId("project") });
  }

  /** GET /api/interface/list_menu — categories, each carrying its (full) interface list. */
  async menu(): Promise<YapiCategory[]> {
    const data = await this.request<unknown>("/api/interface/list_menu", {
      project_id: this.requireProjectId("menu"),
    });
    return dataToList(data) as YapiCategory[];
  }

  /** GET /api/interface/list — one page of the flat interface list. */
  private async listPage(page: number, limit: number): Promise<YapiInterfaceSummary[]> {
    const data = await this.request<unknown>("/api/interface/list", {
      project_id: this.requireProjectId("interfaces"),
      page,
      limit,
    });
    return dataToList(data) as YapiInterfaceSummary[];
  }

  /** All interfaces of the project (flat list, auto-paginated). */
  async interfaces(): Promise<YapiInterfaceSummary[]> {
    const limit = 1000; // official doc suggests a large limit to reduce paging
    const all: YapiInterfaceSummary[] = [];
    for (let page = 1; page <= 100; page++) {
      const items = await this.listPage(page, limit);
      all.push(...items);
      if (items.length < limit) return all;
    }
    return all; // unreachable in practice (100k+ interfaces)
  }

  /** GET /api/interface/list_cat — one page of one category's interfaces. */
  private async listCatPage(catid: number, page: number, limit: number): Promise<YapiInterfaceSummary[]> {
    const data = await this.request<unknown>("/api/interface/list_cat", {
      project_id: this.requireProjectId("cat-ifaces"),
      catid,
      page,
      limit,
    });
    return dataToList(data) as YapiInterfaceSummary[];
  }

  /** All interfaces of one category (auto-paginated). */
  async categoryInterfaces(catid: number): Promise<YapiInterfaceSummary[]> {
    const limit = 1000;
    const all: YapiInterfaceSummary[] = [];
    for (let page = 1; page <= 100; page++) {
      const items = await this.listCatPage(catid, page, limit);
      all.push(...items);
      if (items.length < limit) return all;
    }
    return all;
  }

  /** GET /api/interface/get — full detail of one interface (no project id needed). */
  async getInterface(id: number): Promise<YapiInterface> {
    return this.request<YapiInterface>("/api/interface/get", { id });
  }

  // --- write endpoints (the CLI gates these behind --apply) ---

  /** POST /api/interface/add_cat — create a category inside a project. */
  async addCategory(name: string, desc?: string, pid?: string): Promise<YapiCategory> {
    const projectId = pid ?? this.requireProjectId("cat-add");
    const body: Record<string, unknown> = { project_id: Number(projectId), name };
    if (desc !== undefined && desc.length > 0) body.desc = desc;
    return this.requestPost<YapiCategory>("/api/interface/add_cat", body);
  }

  /**
   * POST /api/interface/up — partial interface update. YApi writes only the
   * fields present in the body (server/controllers/interface.js: `up` does
   * `Object.assign({up_time}, params)`), so a minimal {catid} patch leaves
   * title/path/schemas untouched.
   */
  async updateInterface(id: number, patch: Record<string, unknown>): Promise<unknown> {
    return this.requestPost("/api/interface/up", { id, ...patch });
  }

  /** POST /api/interface/add — create one interface; returns the created doc. */
  async addInterface(fields: Record<string, unknown>): Promise<YapiInterface> {
    return this.requestPost<YapiInterface>("/api/interface/add", fields);
  }

  /** Move an interface to another category of the same project. */
  async moveInterface(id: number, catid: number, message?: string): Promise<unknown> {
    const patch: Record<string, unknown> = { catid };
    if (message !== undefined && message.length > 0) patch.message = message;
    return this.updateInterface(id, patch);
  }

  /**
   * GET /api/project/token — fetch a project's openapi token (session-only
   * endpoint; server auto-creates the token if absent). The returned value is
   * the encoded form usable directly in openapi calls.
   */
  async projectToken(pid?: string): Promise<string> {
    if (!this.isSession()) {
      throw new Error("token retrieval requires session mode (configure username/password).");
    }
    const id = pid ?? this.requireProjectId("token");
    await this.ensureSession();
    const data = await this.request<string>("/api/project/token", { project_id: id });
    if (typeof data !== "string" || data.length === 0) {
      throw new YapiApiError(-1, "unexpected /api/project/token response shape", 200, "/api/project/token", this.env);
    }
    return data;
  }

  /**
   * Session mode only: enumerate every group and its projects visible to the
   * account (GET /api/group/list + GET /api/project/list?group_id=).
   */
  async projects(): Promise<Array<{ groupId: number; groupName?: string; projects: YapiProject[] }>> {
    if (!this.isSession()) {
      throw new Error("projects requires session mode (configure username/password).");
    }
    await this.ensureSession();
    const groups = dataToList(await this.request<unknown>("/api/group/list")) as YapiGroup[];
    return mapLimit(groups, 4, async (g) => {
      const data = await this.request<unknown>("/api/project/list", { group_id: g._id });
      return { groupId: g._id, groupName: g.group_name, projects: dataToList(data) as YapiProject[] };
    });
  }

  /** Probe: does auth work? Session -> /api/user/status; token -> project/get. */
  async status(): Promise<YapiStatus> {
    try {
      if (this.auth.mode === "session") {
        await this.ensureSession();
        // Logged-in shape: errcode=0 and data = the user object (no "login"
        // field); logged-out would be errcode=40011 + data=null (throws here).
        const data = await this.request<{ username?: string; email?: string } | null>(
          "/api/user/status",
          undefined,
          false,
        );
        const loggedIn = data !== null && typeof data === "object";
        return {
          ok: loggedIn,
          env: this.env,
          mode: "session",
          username: data?.username ?? this.auth.username,
          login: loggedIn,
        };
      }
      const p = await this.project();
      return {
        ok: true,
        env: this.env,
        mode: "token",
        projectId: this.auth.projectId,
        projectName: p.name,
      };
    } catch (e) {
      return {
        ok: false,
        env: this.env,
        mode: this.auth.mode,
        projectId: this.auth.projectId,
        username: this.auth.mode === "session" ? this.auth.username : undefined,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Client-side search over the flat interface list (title/path contains keyword). */
  async search(keyword: string, opts?: { status?: string }): Promise<YapiInterfaceSummary[]> {
    const kw = keyword.toLowerCase();
    const all = await this.interfaces();
    return all.filter((it) => {
      if (opts?.status && it.status !== opts.status) return false;
      return (
        (it.title ?? "").toLowerCase().includes(kw) || (it.path ?? "").toLowerCase().includes(kw)
      );
    });
  }

  /** Snapshot project info + categories (summarized) + every interface's full detail. */
  async snapshot(): Promise<YapiSnapshot> {
    const pid = this.requireProjectId("export");
    const project = await this.project();
    const cats = summarizeCategories(await this.menu());
    const list = await this.interfaces();
    const interfaces = await mapLimit(list, 6, (s) => this.getInterface(s._id));
    return {
      env: this.env,
      url: this.baseUrl,
      authMode: this.auth.mode,
      projectId: pid,
      takenAt: new Date().toISOString(),
      project,
      categories: cats,
      interfaces,
    };
  }
}
