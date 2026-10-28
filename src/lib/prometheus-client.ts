// prometheus-client.ts — minimal fetch-based Prometheus HTTP API client (read-only).
// Auth (none / basic / bearer) comes from env or .myws/prometheus.config.json;
// secrets never touch argv. Never return credentials to stdout; enumerate
// instances via the redacted `envs` command.
//
// Consumed by src/prometheus.ts (CLI) and importable from any other script:
//   import { PrometheusClient } from "./lib/prometheus-client.js";
//
// API reference: https://prometheus.io/docs/prometheus/latest/querying/api/

import process from "node:process";

// --- auth ------------------------------------------------------------------

export type PrometheusAuth =
  | { kind: "none" }
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string }; // config auth "apiKey" -> Authorization: Bearer

// --- options / errors ------------------------------------------------------

export interface PrometheusClientOptions {
  baseUrl: string;
  basePath?: string; // e.g. "/prometheus" when served behind a path-prefix proxy
  auth?: PrometheusAuth; // default { kind: "none" }
  timeoutMs?: number; // default 30000
}

export class PrometheusApiError extends Error {
  readonly status: number; // HTTP status; 0 for transport/timeout errors
  readonly body: unknown; // parsed JSON envelope if possible, else raw text
  readonly url: string;
  constructor(status: number, body: unknown, url: string) {
    // Surface the API's own error text (e.g. PromQL parse position) when present.
    const apiMsg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : undefined;
    super(`Prometheus API ${status} at ${url}${apiMsg ? `: ${apiMsg}` : ""}`);
    this.name = "PrometheusApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

// --- response shapes (loose; fields optional — versions differ) ------------

/** Full HTTP API envelope: {status:"success"|"error", data, errorType, error, warnings}. */
export interface PromResponse<T = unknown> {
  status: "success" | "error";
  data?: T;
  errorType?: string; // e.g. "bad_data" (422) on malformed PromQL
  error?: string;
  warnings?: string[];
}

/** One series: labels + instant sample (value) or range samples (values). */
export interface PromSeries {
  metric: Record<string, string>;
  value?: [number, string]; // instant vector / scalar sample [unix_ts, "value"]
  values?: [number, string][]; // range vector samples
}

export interface PromQueryData {
  resultType: "vector" | "matrix" | "scalar" | "string";
  result: PromSeries[] | [number, string];
}

export interface PromRangeParams {
  start: number; // unix seconds
  end: number; // unix seconds
  step: string; // seconds ("60") or duration ("1m")
}

export interface PromTimeWindow {
  start?: number; // unix seconds
  end?: number; // unix seconds
}

export interface PromBuildInfo {
  version?: string;
  revision?: string;
  branch?: string;
  buildUser?: string;
  buildDate?: string;
  goVersion?: string;
  [key: string]: unknown;
}

export interface PromTarget {
  discoveredLabels?: Record<string, string>;
  labels?: Record<string, string>;
  scrapePool?: string;
  scrapeUrl?: string;
  lastError?: string;
  lastScrape?: string;
  health?: "up" | "down" | "unknown";
  [key: string]: unknown;
}

export interface PromTargetsData {
  activeTargets?: PromTarget[];
  droppedTargets?: PromTarget[];
  droppedTargetsCounts?: Record<string, number>;
  [key: string]: unknown;
}

// --- helpers ---------------------------------------------------------------

function toBase64(s: string): string {
  return typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(s);
}

function authFromEnv(env: NodeJS.ProcessEnv): PrometheusAuth {
  const apiKey = env.PROMETHEUS_API_KEY;
  if (apiKey) return { kind: "bearer", token: apiKey };
  const username = env.PROMETHEUS_USERNAME;
  const password = env.PROMETHEUS_PASSWORD;
  if (username && password) return { kind: "basic", username, password };
  return { kind: "none" };
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

// --- client ----------------------------------------------------------------

export class PrometheusClient {
  readonly baseUrl: string;
  readonly basePath: string;
  readonly auth: PrometheusAuth;
  readonly timeoutMs: number;

  constructor(opts: PrometheusClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.basePath = (opts.basePath ?? "").replace(/^\/+|\/+$/g, "");
    this.auth = opts.auth ?? { kind: "none" };
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  /** Build a client from env. Throws if PROMETHEUS_URL is unset. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): PrometheusClient {
    const baseUrl = env.PROMETHEUS_URL;
    if (!baseUrl) {
      throw new Error(
        "PROMETHEUS_URL is not set. Export it (e.g. http://prometheus.example.com) " +
          'or create .myws/prometheus.config.json (run "mycastle prometheus --help").',
      );
    }
    const raw = env.PROMETHEUS_TIMEOUT_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : 30000;
    const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
    return new PrometheusClient({
      baseUrl,
      basePath: env.PROMETHEUS_BASE_PATH,
      auth: authFromEnv(env),
      timeoutMs,
    });
  }

  private authHeader(): string | undefined {
    switch (this.auth.kind) {
      case "none":
        return undefined;
      case "bearer":
        return `Bearer ${this.auth.token}`;
      case "basic":
        return `Basic ${toBase64(`${this.auth.username}:${this.auth.password}`)}`;
    }
  }

  /** GET an API path with query params; returns the full envelope. */
  async request<T>(
    path: string,
    params?: Record<string, string | string[] | undefined>,
  ): Promise<PromResponse<T>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
    }
    const url = buildUrl(this.baseUrl, this.basePath, path, search);

    const headers: Record<string, string> = { Accept: "application/json" };
    const auth = this.authHeader();
    if (auth) headers.Authorization = auth;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new PrometheusApiError(0, null, `timeout after ${this.timeoutMs}ms: ${url}`);
      }
      throw new PrometheusApiError(0, e instanceof Error ? e.message : String(e), url);
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
    const envelope = parsed as PromResponse<T>;
    if (!res.ok || (parsed && typeof parsed === "object" && envelope.status === "error")) {
      throw new PrometheusApiError(res.status, parsed, url);
    }
    return envelope;
  }

  /** Generic GET escape hatch — call any read endpoint (e.g. "/api/v1/rules"). */
  get<T = unknown>(path: string, params?: Record<string, string | string[] | undefined>) {
    return this.request<T>(path, params);
  }

  // --- read-only convenience methods --------------------------------------

  /** GET /api/v1/status/buildinfo — connectivity / version probe. */
  buildinfo(): Promise<PromResponse<PromBuildInfo>> {
    return this.request<PromBuildInfo>("/api/v1/status/buildinfo");
  }

  /** GET /api/v1/query — instant query at `time` (unix seconds; omit = now). */
  query(promql: string, time?: number): Promise<PromResponse<PromQueryData>> {
    return this.request<PromQueryData>("/api/v1/query", {
      query: promql,
      ...(time !== undefined ? { time: String(time) } : {}),
    });
  }

  /** GET /api/v1/query_range — range query over [start, end] by step. */
  queryRange(promql: string, opts: PromRangeParams): Promise<PromResponse<PromQueryData>> {
    return this.request<PromQueryData>("/api/v1/query_range", {
      query: promql,
      start: String(opts.start),
      end: String(opts.end),
      step: opts.step,
    });
  }

  /** GET /api/v1/series — label sets matching the selectors (repeatable match[]). */
  series(
    matchers: string[],
    window?: PromTimeWindow,
  ): Promise<PromResponse<Record<string, string>[]>> {
    return this.request<Record<string, string>[]>("/api/v1/series", {
      "match[]": matchers.length ? matchers : undefined,
      ...(window?.start !== undefined ? { start: String(window.start) } : {}),
      ...(window?.end !== undefined ? { end: String(window.end) } : {}),
    });
  }

  /** GET /api/v1/labels — label names, optionally scoped by match[] + window. */
  labels(matchers: string[], window?: PromTimeWindow): Promise<PromResponse<string[]>> {
    return this.request<string[]>("/api/v1/labels", {
      "match[]": matchers.length ? matchers : undefined,
      ...(window?.start !== undefined ? { start: String(window.start) } : {}),
      ...(window?.end !== undefined ? { end: String(window.end) } : {}),
    });
  }

  /** GET /api/v1/label/<name>/values — values of one label, optionally scoped. */
  labelValues(
    label: string,
    matchers: string[],
    window?: PromTimeWindow,
  ): Promise<PromResponse<string[]>> {
    return this.request<string[]>(`/api/v1/label/${encodeURIComponent(label)}/values`, {
      "match[]": matchers.length ? matchers : undefined,
      ...(window?.start !== undefined ? { start: String(window.start) } : {}),
      ...(window?.end !== undefined ? { end: String(window.end) } : {}),
    });
  }

  /** GET /api/v1/targets — scrape targets (active + dropped). */
  targets(): Promise<PromResponse<PromTargetsData>> {
    return this.request<PromTargetsData>("/api/v1/targets");
  }
}
