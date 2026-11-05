// jenkins-client.ts — minimal fetch-based Jenkins Remote Access API client.
// Auth: API Token + preemptive Basic auth (username:apiToken). Jenkins never
// 401-negotiates — unauthenticated requests get 403 straight away — so every
// request must already carry credentials. Basic auth with an API token is
// CSRF/crumb-exempt on Jenkins >= 2.96, so no crumb dance is needed.
// Secrets live in .myws/jenkins.config.json or env vars — never argv/stdout.
//
// Consumed by src/jenkins.ts (CLI) and importable from any other script:
//   import { JenkinsClient } from "./lib/jenkins-client.js";
//
// API reference: https://www.jenkins.io/doc/book/using/remote-access-api/
// Gotchas encoded here (see the repo docs page for jenkins):
//   - `tree` expressions contain `[]` / `{}` which must be URL-encoded when
//     a front proxy (Tomcat) rejects raw brackets — URLSearchParams does this.
//   - Nested jobs live under folders: job "a/b" maps to /job/a/job/b/.
//   - Build refs accept numbers or aliases (lastBuild, lastCompletedBuild, ...).

import process from "node:process";

// --- options / errors -------------------------------------------------------

export interface JenkinsClientOptions {
  baseUrl: string;
  basePath?: string; // reverse-proxy context path, e.g. "/jenkins"; default ""
  username?: string; // with apiToken -> preemptive Basic auth
  apiToken?: string;
  timeoutMs?: number; // default 30000
}

export class JenkinsApiError extends Error {
  readonly status: number; // HTTP status; 0 for transport/timeout errors
  readonly body: unknown; // parsed JSON when possible, else raw text
  readonly url: string;
  constructor(status: number, body: unknown, url: string) {
    let apiMsg: string | undefined;
    if (typeof body === "string") {
      apiMsg = body.length > 200 ? `${body.slice(0, 200)}…` : body;
    } else if (body && typeof body === "object") {
      const maybe = (body as { message?: unknown }).message;
      if (typeof maybe === "string") apiMsg = maybe;
    }
    const hint =
      status === 403
        ? " (Jenkins answers 403 — not 401 — for missing/invalid credentials; check username/apiToken)"
        : "";
    super(`Jenkins API ${status} at ${url}${apiMsg ? `: ${apiMsg}` : ""}${hint}`);
    this.name = "JenkinsApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

// --- response shapes (loose; fields optional — job types differ) ------------

export interface JenkinsBuildRef {
  number?: number;
  url?: string;
  timestamp?: number; // unix ms
  result?: string | null; // SUCCESS/UNSTABLE/FAILURE/ABORTED/NOT_BUILT; null while building
  duration?: number; // ms
  building?: boolean;
  [key: string]: unknown;
}

export interface JenkinsJobNode {
  name?: string;
  color?: string;
  url?: string;
  lastBuild?: JenkinsBuildRef;
  jobs?: JenkinsJobNode[]; // folders only
  [key: string]: unknown;
}

export interface JenkinsParameterDefinition {
  name?: string;
  type?: string;
  defaultParameterValue?: { value?: unknown };
  choices?: unknown;
  [key: string]: unknown;
}

/** Build-ref aliases accepted anywhere a build number is expected. */
export const BUILD_ALIASES = [
  "lastBuild",
  "lastCompletedBuild",
  "lastSuccessfulBuild",
  "lastFailedBuild",
  "lastStableBuild",
] as const;

// --- helpers ----------------------------------------------------------------

function toBase64(s: string): string {
  return typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(s);
}

function authFromEnv(env: NodeJS.ProcessEnv): { username?: string; apiToken?: string } {
  const username = env.JENKINS_USERNAME;
  const apiToken = env.JENKINS_API_TOKEN;
  return {
    ...(username ? { username } : {}),
    ...(apiToken ? { apiToken } : {}),
  };
}

function buildUrl(
  baseUrl: string,
  basePath: string,
  path: string,
  params?: URLSearchParams,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const bp = basePath.replace(/^\/+|\/+$/g, "");
  const p = path.replace(/^\/+/, "");
  const url = bp ? `${base}/${bp}/${p}` : `${base}/${p}`;
  const qs = params?.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Job name -> URL path. "a" -> /job/a; nested "a/b" -> /job/a/job/b (folders).
 * Each segment is URL-encoded; empty segments are rejected.
 */
export function jobUrlPath(name: string): string {
  const parts = name
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("job name must not be empty");
  return parts.map((p) => `/job/${encodeURIComponent(p)}`).join("");
}

/**
 * Nested `tree` expression for top-level jobs down to `depth` folder levels
 * (1 = top level only). Generated recursively so callers never hand-write
 * brackets (syntax errors surface as bare 500s on the Jenkins side).
 */
export function jobsTree(depth: number): string {
  const leaf = "name,color,url,lastBuild[number,timestamp,result]";
  const build = (n: number): string => (n <= 1 ? leaf : `${leaf},jobs[${build(n - 1)}]`);
  return `jobs[${build(depth)}]`;
}

/** Normalize a user-supplied path: split off "?query" and re-encode it, so raw
 * `[]` in a caller-built query can never reach a bracket-rejecting proxy. */
function normalizePath(path: string): { path: string; params?: URLSearchParams } {
  const qIdx = path.indexOf("?");
  if (qIdx === -1) return { path };
  return {
    path: path.slice(0, qIdx),
    params: new URLSearchParams(path.slice(qIdx + 1)),
  };
}

// --- client ----------------------------------------------------------------

export class JenkinsClient {
  readonly baseUrl: string;
  readonly basePath: string;
  readonly username?: string;
  readonly apiToken?: string;
  readonly timeoutMs: number;

  constructor(opts: JenkinsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.basePath = (opts.basePath ?? "").replace(/^\/+|\/+$/g, "");
    this.username = opts.username;
    this.apiToken = opts.apiToken;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  /** Build a client from env. Throws if JENKINS_URL is unset. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): JenkinsClient {
    const baseUrl = env.JENKINS_URL;
    if (!baseUrl) {
      throw new Error(
        "JENKINS_URL is not set. Export it (e.g. http://jenkins.example.com) " +
          'or create .myws/jenkins.config.json (run "mycastle jenkins --help").',
      );
    }
    const raw = env.JENKINS_TIMEOUT_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : 30000;
    const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
    return new JenkinsClient({
      baseUrl,
      basePath: env.JENKINS_BASE_PATH,
      ...authFromEnv(env),
      timeoutMs,
    });
  }

  private authHeader(): string | undefined {
    if (!this.username || !this.apiToken) return undefined;
    return `Basic ${toBase64(`${this.username}:${this.apiToken}`)}`;
  }

  /** Low-level request; returns the Response plus the body as text. */
  private async send(
    path: string,
    opts: {
      method?: "GET" | "POST";
      params?: URLSearchParams;
      form?: Record<string, string>;
    } = {},
  ): Promise<{ res: Response; text: string; url: string }> {
    const norm = normalizePath(path);
    // Query from a caller-built "?query" in the path is the base; structured
    // params overlay it (either source may be absent; an EMPTY opts.params
    // must not mask the path's query).
    let params: URLSearchParams | undefined = norm.params;
    if (opts.params) {
      for (const [k, v] of opts.params) {
        params = params ?? new URLSearchParams();
        params.set(k, v);
      }
    }
    const url = buildUrl(this.baseUrl, this.basePath, norm.path, params);

    const headers: Record<string, string> = { Accept: "application/json" };
    const auth = this.authHeader();
    if (auth) headers.Authorization = auth;
    let body: string | undefined;
    if (opts.method === "POST") {
      // redirect:"manual": write endpoints answer 201/302; following a 302
      // would re-issue the request as GET against an HTML page.
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = opts.form ? new URLSearchParams(opts.form).toString() : "";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body,
        redirect: opts.method === "POST" ? "manual" : "follow",
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new JenkinsApiError(0, null, `timeout after ${this.timeoutMs}ms: ${url}`);
      }
      throw new JenkinsApiError(0, e instanceof Error ? e.message : String(e), url);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    return { res, text, url };
  }

  /** GET a JSON endpoint; returns parsed JSON + selected response headers. */
  async json<T>(
    path: string,
    opts: { params?: Record<string, string | undefined> } = {},
  ): Promise<{ json: T; headers: Headers; status: number }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined) params.set(k, v);
    }
    const { res, text, url } = await this.send(path, { params });
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text (auth-redirect HTML, proxy error pages) */
      }
    }
    if (!res.ok || typeof parsed === "string") {
      throw new JenkinsApiError(res.status, parsed, url);
    }
    return { json: parsed as T, headers: res.headers, status: res.status };
  }

  /** GET any read endpoint, returning plain text (logs, consoleText, config.xml). */
  async text(path: string, params?: Record<string, string | undefined>): Promise<string> {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) search.set(k, v);
    }
    const { res, text, url } = await this.send(path, { params: search });
    if (!res.ok) throw new JenkinsApiError(res.status, text, url);
    return text;
  }

  /** POST a Jenkins action endpoint; 2xx/3xx count as success. */
  async post(
    path: string,
    form?: Record<string, string>,
  ): Promise<{ status: number; location: string | null }> {
    const { res, text, url } = await this.send(path, { method: "POST", form });
    const ok = (res.status >= 200 && res.status < 300) || (res.status >= 300 && res.status < 400);
    if (!ok) throw new JenkinsApiError(res.status, text, url);
    return { status: res.status, location: res.headers.get("location") };
  }

  /** Generic JSON GET escape hatch — call any read endpoint not covered above. */
  get<T = unknown>(path: string, params?: Record<string, string | undefined>) {
    return this.json<T>(path, { params });
  }

  // --- read-only convenience methods --------------------------------------

  /**
   * GET /api/json with a small tree + the X-Jenkins version header —
   * connectivity / auth probe and instance summary in one call.
   */
  async instanceStatus(): Promise<{
    json: {
      quietingDown?: boolean;
      useSecurity?: boolean;
      primaryView?: { name?: string };
      views?: { name?: string }[];
      jobs?: JenkinsJobNode[];
    };
    version: string | null;
    status: number;
  }> {
    const { json, headers, status } = await this.json<{
      quietingDown?: boolean;
      useSecurity?: boolean;
      primaryView?: { name?: string };
      views?: { name?: string }[];
      jobs?: JenkinsJobNode[];
    }>("/api/json", {
      params: {
        tree: "quietingDown,useSecurity,primaryView[name],views[name],jobs[name,color]",
      },
    });
    return { json, version: headers.get("x-jenkins"), status };
  }

  /** GET /me/api/json — identity + granted authorities; doubles as auth check. */
  whoami(): Promise<{ json: Record<string, unknown>; headers: Headers; status: number }> {
    return this.json("/me/api/json");
  }

  /** GET /view/<view>/api/json or the root API with a nested-jobs tree. */
  listJobs(opts: { view?: string; depth?: number } = {}) {
    const depth = Math.max(1, Math.min(5, Math.trunc(opts.depth ?? 1)));
    const path = opts.view ? `/view/${encodeURIComponent(opts.view)}/api/json` : "/api/json";
    return this.json<{ jobs?: JenkinsJobNode[] }>(path, { params: { tree: jobsTree(depth) } });
  }

  /** GET /job/<path>/api/json — one job's details (health, last builds, params). */
  job(name: string) {
    return this.json(jobUrlPath(name) + "/api/json", {
      params: {
        tree:
          "name,displayName,description,color,url,building,inQueue," +
          "healthReport[score,description]," +
          "lastBuild[number,timestamp,result,duration,building]," +
          "lastSuccessfulBuild[number,timestamp],lastCompletedBuild[number,timestamp,result]," +
          "property[parameterDefinitions[name,type,defaultParameterValue[value],choices]]",
      },
    });
  }

  /**
   * GET /job/<path>/api/json with an allBuilds tree — build history, newest
   * first. allBuilds works across job types (freestyle / workflow / maven
   * module sets); `builds` alone misses some. Slice syntax: measured
   * 2026-11 against a 2.346.1 LTS instance, `prop[fields]{0,n}` parses while
   * the documented `prop{0,n}[fields]` order answers 500 — try both before
   * falling back to the un-sliced query (client-side slice).
   */
  async builds(name: string, limit = 20): Promise<{ builds?: JenkinsBuildRef[] }> {
    const n = Math.max(1, Math.min(100, Math.trunc(limit)));
    const fields = "number,timestamp,result,duration,building";
    const path = jobUrlPath(name) + "/api/json";
    const attempts = [`allBuilds[${fields}]{0,${n}}`, `allBuilds{0,${n}}[${fields}]`];
    for (const tree of attempts) {
      try {
        const { json } = await this.json<{ builds?: JenkinsBuildRef[]; allBuilds?: JenkinsBuildRef[] }>(
          path,
          { params: { tree } },
        );
        return { builds: json.allBuilds ?? json.builds };
      } catch (e) {
        // tree syntax variants answer 500; anything else is a real error.
        if (!(e instanceof JenkinsApiError) || e.status !== 500) throw e;
      }
    }
    const { json } = await this.json<{ builds?: JenkinsBuildRef[]; allBuilds?: JenkinsBuildRef[] }>(
      path,
      { params: { tree: `allBuilds[${fields}]` } },
    );
    const all = json.allBuilds ?? json.builds ?? [];
    return { builds: all.slice(0, n) };
  }

  /** GET /job/<path>/<ref>/api/json — one build's details (params, node, result). */
  build(name: string, ref: string | number) {
    return this.json<JenkinsBuildRef>(jobUrlPath(name) + `/${encodeURIComponent(String(ref))}/api/json`);
  }

  /**
   * GET /job/<path>/<ref>/logText/progressiveText — log slice from byte offset
   * `start`. Returns the text plus x-more-data / x-text-size for incremental
   * pulls (pass the reported size back as the next `start`).
   */
  async logSlice(
    name: string,
    ref: string | number,
    start = 0,
  ): Promise<{ text: string; hasMore: boolean; size: number }> {
    const refSafe = encodeURIComponent(String(ref));
    const { res, text, url } = await this.send(
      jobUrlPath(name) + `/${refSafe}/logText/progressiveText`,
      { params: new URLSearchParams(start > 0 ? { start: String(start) } : {}) },
    );
    if (!res.ok) throw new JenkinsApiError(res.status, text, url);
    const size = Number.parseInt(res.headers.get("x-text-size") ?? "", 10);
    return {
      text,
      hasMore: res.headers.get("x-more-data") === "1",
      size: Number.isFinite(size) ? size : start + Buffer.byteLength(text, "utf8"),
    };
  }

  /** GET /job/<path>/<ref>/consoleText — the whole log in one response. */
  consoleText(name: string, ref: string | number): Promise<string> {
    return this.text(jobUrlPath(name) + `/${encodeURIComponent(String(ref))}/consoleText`);
  }

  /** GET /queue/api/json — items waiting to start. */
  queue() {
    return this.json<{ items?: Record<string, unknown>[] }>("/queue/api/json", {
      params: {
        tree: "items[id,why,inQueueSince,blocked,stuck,task[name,url]]",
      },
    });
  }

  /** GET /computer/api/json — nodes (incl. Built-In) and executor slots. */
  nodes() {
    return this.json<{ computer?: Record<string, unknown>[] }>("/computer/api/json", {
      params: {
        tree:
          "computer[displayName,offline,temporarilyOffline,idle,numExecutors,offlineCause]",
      },
    });
  }

  /** GET /api/json?tree=views[name] — view names only. */
  views() {
    return this.json<{ views?: { name?: string }[] }>("/api/json", {
      params: { tree: "views[name]" },
    });
  }

  // --- write endpoints (the CLI gates these behind --yes) ------------------

  /**
   * POST /job/<path>/build[WithParameters] — trigger a build. Parameterized
   * jobs must use buildWithParameters; a parameterless POST to a
   * parameterized job is rejected by Jenkins, so pick by params emptiness.
   * Returns the queue item location (".../queue/item/<id>/") when queued.
   */
  trigger(name: string, params: Record<string, string> = {}) {
    const keys = Object.keys(params);
    const path =
      keys.length > 0
        ? jobUrlPath(name) + "/buildWithParameters"
        : jobUrlPath(name) + "/build";
    return this.post(path, keys.length > 0 ? params : undefined);
  }

  /** POST /job/<path>/<ref>/stop — abort a build. */
  stop(name: string, ref: string | number) {
    return this.post(jobUrlPath(name) + `/${encodeURIComponent(String(ref))}/stop`);
  }
}
