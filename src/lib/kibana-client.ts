// kibana-client.ts — minimal fetch-based Kibana REST API client (read-only).
// Auth (none / api key / basic) is resolved from config fields or env; secrets never touch argv.
// Never return credentials to stdout; enumerate instances via the redacted `envs` command.
//
// Consumed by src/kibana.ts (CLI) and importable from any other script:
//   import { KibanaClient } from "./lib/kibana-client.js";

import process from "node:process";

// --- auth ------------------------------------------------------------------

export type KibanaAuth =
  | { kind: "none" }
  | { kind: "apiKey"; token: string } // token already in its final (base64) form
  | { kind: "basic"; username: string; password: string };

/** Auth source fields — works for both env vars and config-file env entries. */
export interface KibanaAuthSource {
  apiKey?: string;
  username?: string;
  password?: string;
}

// --- options / errors ------------------------------------------------------

export interface KibanaClientOptions {
  baseUrl: string;
  basePath?: string; // e.g. "/kibana" when server.basePath is set; default ""
  auth?: KibanaAuth; // default { kind: "none" }
  timeoutMs?: number; // default 30000
}

export class KibanaApiError extends Error {
  readonly status: number; // HTTP status; 0 for transport/timeout errors
  readonly body: unknown; // parsed JSON if possible, else raw text
  readonly url: string;
  constructor(status: number, body: unknown, url: string) {
    super(`Kibana API ${status} at ${url}`);
    this.name = "KibanaApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

// --- response shapes (loose; fields optional — versions differ) ------------

export interface KibanaStatus {
  name?: string;
  uuid?: string;
  status?: "green" | "yellow" | "red" | string;
  version?: { number?: string; build_number?: number; build_hash?: string };
  [key: string]: unknown;
}

export interface Space {
  id: string;
  name: string;
  description?: string;
  color?: string;
  initials?: string;
  disabledFeatures?: string[];
}

export interface DataViewListItem {
  id: string;
  name?: string;
  title?: string;
  names?: string;
  type?: string;
}

export interface DataView {
  id: string;
  title?: string;
  name?: string;
  timeFieldName?: string;
  type?: string;
  [key: string]: unknown;
}

// --- log search (space-scoped Elasticsearch passthrough) --------------------

/** Loose shape of an Elasticsearch `_search` response (fields optional — versions differ). */
export interface EsSearchResponse {
  took?: number;
  timed_out?: boolean;
  hits?: {
    total?: number | { value: number; relation: string };
    max_score?: number | null;
    hits?: Array<{
      _index?: string;
      _id?: string;
      _score?: number | null;
      _source?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
  };
  aggregations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SpaceSearchParams {
  /** Kibana space id. Omit for the default space (no `/s/` prefix). */
  space?: string;
  /** Index or index pattern, e.g. "my-service*". */
  index: string;
  /** Full Elasticsearch search body (query / sort / size / aggs ...). */
  body: unknown;
}

// --- helpers ---------------------------------------------------------------

function toBase64(s: string): string {
  // Buffer exists in Node; btoa is the browser/global fallback.
  return typeof Buffer !== "undefined"
    ? Buffer.from(s, "utf8").toString("base64")
    : btoa(s);
}

/** Normalize an API key credential: "id:api_key" -> base64; a ready token passes through. */
export function toApiKeyToken(apiKey: string): string {
  return apiKey.includes(":") ? toBase64(apiKey) : apiKey;
}

/** Resolve auth from generic source fields (env vars or config-file env entry). */
export function resolveAuth(src: KibanaAuthSource): KibanaAuth {
  const apiKey = src.apiKey;
  if (apiKey) return { kind: "apiKey", token: toApiKeyToken(apiKey) };
  const username = src.username;
  const password = src.password;
  if (username && password) return { kind: "basic", username, password };
  return { kind: "none" };
}

function authFromEnv(env: NodeJS.ProcessEnv): KibanaAuth {
  return resolveAuth({
    apiKey: env.KIBANA_API_KEY,
    username: env.KIBANA_USERNAME,
    password: env.KIBANA_PASSWORD,
  });
}

function buildUrl(baseUrl: string, basePath: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const bp = basePath.replace(/^\/+|\/+$/g, "");
  const p = path.replace(/^\/+/, "");
  return bp ? `${base}/${bp}/${p}` : `${base}/${p}`;
}

// --- client ----------------------------------------------------------------

export class KibanaClient {
  readonly baseUrl: string;
  readonly basePath: string;
  readonly auth: KibanaAuth;
  readonly timeoutMs: number;

  constructor(opts: KibanaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.basePath = (opts.basePath ?? "").replace(/^\/+|\/+$/g, "");
    this.auth = opts.auth ?? { kind: "none" };
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  /** Build a client from env. Throws if KIBANA_URL is unset. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): KibanaClient {
    const baseUrl = env.KIBANA_URL;
    if (!baseUrl) {
      throw new Error(
        "KIBANA_URL is not set. Export it (e.g. http://kibana.example.com) before running.",
      );
    }
    const raw = env.KIBANA_TIMEOUT_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : 30000;
    const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
    return new KibanaClient({
      baseUrl,
      basePath: env.KIBANA_BASE_PATH,
      auth: authFromEnv(env),
      timeoutMs,
    });
  }

  private authHeader(): string | undefined {
    switch (this.auth.kind) {
      case "none":
        return undefined;
      case "apiKey":
        return `ApiKey ${this.auth.token}`;
      case "basic":
        return `Basic ${toBase64(`${this.auth.username}:${this.auth.password}`)}`;
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = buildUrl(this.baseUrl, this.basePath, path);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "kbn-xsrf": "kibana-cli", // required for writes; harmless on GET
    };
    const auth = this.authHeader();
    if (auth) headers.Authorization = auth;

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new KibanaApiError(0, null, `timeout after ${this.timeoutMs}ms: ${url}`);
      }
      throw new KibanaApiError(0, e instanceof Error ? e.message : String(e), url);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text for non-JSON (gateway HTML, etc.) */
      }
    }
    if (!res.ok) throw new KibanaApiError(res.status, parsed, url);
    return parsed as T;
  }

  /** Generic GET escape hatch — call any read endpoint. */
  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /**
   * POST /s/{space}/elasticsearch/{index}/_search — the same Elasticsearch
   * passthrough the Kibana UI (Discover) uses, scoped to one space.
   * Read-only: this is the only POST surface the client exposes.
   */
  search<T = EsSearchResponse>(opts: SpaceSearchParams): Promise<T> {
    const prefix = opts.space ? `/s/${encodeURIComponent(opts.space)}` : "";
    const index = encodeURIComponent(opts.index); // `*` is left as-is — fine for ES
    return this.request<T>("POST", `${prefix}/elasticsearch/${index}/_search`, opts.body);
  }

  // --- read-only convenience methods --------------------------------------

  status(): Promise<KibanaStatus> {
    return this.request<KibanaStatus>("GET", "/api/status");
  }

  readonly spaces = {
    list: (): Promise<Space[]> => this.request<Space[]>("GET", "/api/spaces/space"),
    get: (id: string): Promise<Space> =>
      this.request<Space>("GET", `/api/spaces/space/${encodeURIComponent(id)}`),
  };

  readonly dataViews = {
    // GET /api/data_views returns { data_view: [...] }; unwrap to the array.
    list: async (): Promise<DataViewListItem[]> => {
      const res = await this.request<{ data_view: DataViewListItem[] }>(
        "GET",
        "/api/data_views",
      );
      return res.data_view ?? [];
    },
    // GET /api/data_views/data_view/{id} returns { data_view: {...} }; unwrap.
    get: async (id: string): Promise<DataView> => {
      const res = await this.request<{ data_view: DataView }>(
        "GET",
        `/api/data_views/data_view/${encodeURIComponent(id)}`,
      );
      return res.data_view;
    },
  };
}
