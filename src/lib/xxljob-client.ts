// xxljob-client.ts — minimal fetch-based XXL-Job admin client (read-only).
// Session = XXL_JOB_LOGIN_IDENTITY cookie, persisted per env via xxljob-session.js.

import crypto from "node:crypto";
import { clearSession, readSession, writeSession } from "./xxljob-session.js";

export const LOGIN_COOKIE = "XXL_JOB_LOGIN_IDENTITY";

export class XxljobApiError extends Error {
  readonly status: number; // HTTP status; 0 for transport/timeout
  readonly body: unknown; // parsed JSON if possible, else raw text
  readonly url: string;
  readonly env: string;
  constructor(status: number, body: unknown, url: string, env: string) {
    super(`XXL-Job API ${status} at ${url} [env=${env}]`);
    this.name = "XxljobApiError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.env = env;
  }
}

// --- response shapes (loose; fields optional — xxl-job versions differ) ---

export interface Executor {
  id: number;
  appName?: string;
  title?: string;
  addressList?: string;
  registryList?: string;
  [key: string]: unknown;
}

export interface Job {
  id: number;
  jobGroup?: number;
  jobDesc?: string;
  jobCron?: string;
  executorHandler?: string;
  executorParam?: string;
  executorRouteStrategy?: string;
  executorBlockStrategy?: string;
  glueType?: string;
  triggerStatus?: number;
  [key: string]: unknown;
}

export interface JobLog {
  id: number;
  jobGroup?: number;
  jobId?: number;
  triggerTime?: string;
  triggerCode?: number;
  triggerMsg?: string;
  handleTime?: string;
  handleCode?: number;
  handleMsg?: string;
  [key: string]: unknown;
}

export interface Snapshot {
  env: string;
  url: string;
  takenAt: string;
  executors: Executor[];
  jobs: Job[];
}

interface XxlResult<T> {
  code?: number;
  msg?: string;
  recordsTotal?: number;
  data?: T[];
  [key: string]: unknown;
}

// --- helpers ---------------------------------------------------------------

function buildUrl(baseUrl: string, p: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = p.replace(/^\/+/, "");
  return `${base}/${path}`;
}

function md5hex(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

/** Extract the LOGIN_COOKIE value from a Set-Cookie header string. */
function cookieValueFromHeader(setCookie: string): string | undefined {
  const key = `${LOGIN_COOKIE}=`;
  const idx = setCookie.indexOf(key);
  if (idx < 0) return undefined;
  const rest = setCookie.slice(idx + key.length);
  const end = rest.indexOf(";");
  return end >= 0 ? rest.slice(0, end) : rest;
}

const LOGIN_PAGE_MARKERS = ["/login", "XXL_JOB_LOGIN_IDENTITY", 'name="userName"'];

/** Heuristic: does this response body look like the login page (session expired)? */
export function isLoginPage(body: unknown): boolean {
  if (typeof body !== "string") return false;
  return LOGIN_PAGE_MARKERS.some((m) => body.includes(m));
}

/** Scrape executor options from the /jobinfo page's <select> blocks.
 *  The page renders the jobGroup <select> multiple times (filter + add/edit
 *  dialogs), so dedupe by id and drop the id<=0 placeholder ("全部"/"请选择"). */
export function parseExecutorsFromHtml(html: string): Executor[] {
  const seen = new Set<number>();
  const out: Executor[] = [];
  const re = /<option\s+value="(\d+)"[^>]*>([^<]+)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = Number.parseInt(m[1]!, 10);
    const label = m[2]!.trim();
    if (Number.isFinite(id) && id > 0 && label.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push({ id, title: label, appName: label });
    }
  }
  return out;
}

// --- client ----------------------------------------------------------------

export interface XxljobClientOptions {
  env: string;
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number; // default 30000
}

export class XxljobClient {
  readonly env: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  private cookie: string | undefined;

  constructor(opts: XxljobClientOptions) {
    this.env = opts.env;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.username = opts.username;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  // --- session cookie ---

  /** Load persisted cookie into memory; returns true if a cookie is available. */
  loadSession(): boolean {
    const rec = readSession(this.env);
    this.cookie = rec?.cookie;
    return !!this.cookie;
  }

  /** Ensure we have a cookie; login (fresh) if none is persisted. */
  async ensureSession(): Promise<void> {
    if (!this.loadSession()) await this.login();
  }

  // --- auth ---

  /** Login (plaintext first; MD5 fallback) and persist the cookie. Throws on failure. */
  async login(): Promise<void> {
    const tryLogin = async (pw: string): Promise<boolean> => {
      const res = await this.doFetch("POST", "/login", { userName: this.username, password: pw });
      const setCookie = res.headers.get("set-cookie") ?? "";
      const cookie = cookieValueFromHeader(setCookie);
      const body = await res.text();
      let json: unknown = body;
      if (body) {
        try {
          json = JSON.parse(body);
        } catch {
          /* keep text */
        }
      }
      const code = (json as { code?: number } | undefined)?.code;
      if (code === 200 && cookie) {
        this.acceptCookie(cookie);
        return true;
      }
      return false;
    };
    const ok = (await tryLogin(this.password)) || (await tryLogin(md5hex(this.password)));
    if (!ok) {
      this.cookie = undefined;
      throw new Error(
        `Login failed for env="${this.env}" user="${this.username}" (tried plaintext + MD5).`,
      );
    }
  }

  /** Persist a freshly obtained cookie value. */
  private acceptCookie(cookie: string): void {
    this.cookie = cookie;
    writeSession(this.env, cookie);
  }

  /** Logout on the server and clear the persisted cookie (best-effort). */
  async logout(): Promise<void> {
    try {
      await this.request("POST", "/logout");
    } finally {
      this.cookie = undefined;
      clearSession(this.env);
    }
  }

  /** Probe: is the current session usable? Never throws — returns {ok, env}. */
  async status(): Promise<{ ok: boolean; env: string }> {
    try {
      await this.ensureSession();
      await this.request("POST", "/jobinfo/pageList", { start: "0", length: "1" });
      return { ok: true, env: this.env };
    } catch {
      return { ok: false, env: this.env };
    }
  }

  // --- HTTP core ---

  /**
   * Form-encoded request body (parsed JSON, or raw text if not JSON). Detects a
   * returned login page (session expired) and re-logins once, then retries.
   */
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
    const res = await this.doFetch(method, p, form);
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
    if (res.status < 200 || res.status >= 300) {
      throw new XxljobApiError(res.status, body, buildUrl(this.baseUrl, p), this.env);
    }
    return body as T;
  }

  /** Low-level fetch: headers, form body, cookie, timeout. Default redirect follow. */
  protected async doFetch(
    method: string,
    p: string,
    form?: Record<string, string>,
  ): Promise<Response> {
    const url = buildUrl(this.baseUrl, p);
    const headers: Record<string, string> = {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: this.baseUrl,
    };
    if (this.cookie) headers.Cookie = `${LOGIN_COOKIE}=${this.cookie}`;
    const init: RequestInit = { method, headers };
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
        throw new XxljobApiError(0, null, `timeout after ${this.timeoutMs}ms: ${url}`, this.env);
      }
      throw new XxljobApiError(0, e instanceof Error ? e.message : String(e), url, this.env);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- resources ---

  readonly executors = {
    list: async (): Promise<Executor[]> => this.executorsList(),
  };

  private async executorsList(): Promise<Executor[]> {
    await this.ensureSession();
    // Preferred: /jobgroup/pageList returns JSON {data:[...]}.
    try {
      const res = await this.send<unknown>(
        "POST",
        "/jobgroup/pageList",
        { start: "0", length: "1000" },
        true,
      );
      if (res && typeof res === "object" && Array.isArray((res as XxlResult<Executor>).data)) {
        return (res as XxlResult<Executor>).data ?? [];
      }
    } catch {
      /* endpoint unavailable (e.g. 404) — fall through to HTML scrape */
    }
    // Fallback: scrape the executor <select> from the /jobinfo HTML page.
    const html = await this.request<string>("GET", "/jobinfo");
    return parseExecutorsFromHtml(typeof html === "string" ? html : "");
  }

  private async jobPage(
    group: number,
    opts: { status?: number; handler?: string; start: number; length: number },
  ): Promise<{ recordsTotal: number; data: Job[] }> {
    const form: Record<string, string> = {
      jobGroup: String(group),
      triggerStatus: String(opts.status ?? -1),
      jobDesc: "",
      executorHandler: opts.handler ?? "",
      author: "",
      start: String(opts.start),
      length: String(opts.length),
    };
    const res = await this.request<XxlResult<Job>>("POST", "/jobinfo/pageList", form);
    return { recordsTotal: res.recordsTotal ?? 0, data: res.data ?? [] };
  }

  /** All jobs for one executor (paginated until recordsTotal reached). */
  async fetchJobsForGroup(
    group: number,
    opts?: { status?: number; handler?: string },
  ): Promise<Job[]> {
    const length = 100;
    let start = 0;
    const all: Job[] = [];
    for (;;) {
      const page = await this.jobPage(group, { ...opts, start, length });
      all.push(...page.data);
      if (page.data.length < length || all.length >= page.recordsTotal) break;
      start += length;
      if (page.recordsTotal > 0 && start > page.recordsTotal) break;
    }
    return all;
  }

  readonly jobs = {
    list: async (opts?: { group?: number; status?: number; handler?: string }): Promise<Job[]> => {
      await this.ensureSession();
      if (opts?.group !== undefined) return this.fetchJobsForGroup(opts.group, opts);
      // no group → all jobs across every executor
      const exes = await this.executorsList();
      const all: Job[] = [];
      for (const ex of exes) all.push(...(await this.fetchJobsForGroup(ex.id, opts)));
      return all;
    },
    get: async (id: number): Promise<Job> => {
      await this.ensureSession();
      try {
        const res = await this.request<{ content?: Job } | Job>(
          "GET",
          `/jobinfo/loadById?id=${id}`,
        );
        const obj = res as { content?: Job };
        if (obj && obj.content) return obj.content;
        return res as Job;
      } catch {
        // Fallback: filter from the full list (slower, but works without loadById).
        const all = await this.jobs.list();
        const found = all.find((j) => j.id === id);
        if (!found) throw new XxljobApiError(404, null, `/jobinfo/loadById?id=${id}`, this.env);
        return found;
      }
    },
    log: async (
      id: number,
      opts: { group: number; status?: number; start?: number; length?: number },
    ): Promise<JobLog[]> => {
      await this.ensureSession();
      const form: Record<string, string> = {
        jobGroup: String(opts.group),
        jobId: String(id),
        logStatus: String(opts.status ?? -1),
        filterTime: "",
        start: String(opts.start ?? 0),
        length: String(opts.length ?? 20),
      };
      const res = await this.request<XxlResult<JobLog>>("POST", "/joblog/pageList", form);
      return res.data ?? [];
    },
  };

  /** Snapshot all executors + all their jobs (no scheduling logs). */
  async snapshot(): Promise<Snapshot> {
    await this.ensureSession();
    const executors = await this.executorsList();
    const jobs: Job[] = [];
    for (const ex of executors) {
      jobs.push(...(await this.fetchJobsForGroup(ex.id)));
    }
    return {
      env: this.env,
      url: this.baseUrl,
      takenAt: new Date().toISOString(),
      executors,
      jobs,
    };
  }
}
