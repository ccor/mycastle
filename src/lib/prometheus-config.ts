// prometheus-config.ts — load .myws/prometheus.config.json and resolve the target env(s).
// Real URLs/credentials live ONLY in this gitignored file; never in code or flags.
// Per-env auth modes: "none" (anonymous) | "basic" | "apiKey" (Bearer token,
// typically for an auth proxy in front of Prometheus);
// "auth" may be omitted and is then inferred from the credential fields present.
// Never return these values to stdout; enumerate via the redacted `envs` command.

import fs from "node:fs";
import path from "node:path";
import type { PrometheusAuth, PrometheusClientOptions } from "./prometheus-client.js";

export type PrometheusAuthMode = "none" | "basic" | "apiKey";

export interface PrometheusEnvConfig {
  url: string;
  basePath?: string; // e.g. "/prometheus" behind a path-prefix proxy; default ""
  timeoutMs?: number; // default 30000 (client default)
  auth?: PrometheusAuthMode; // omitted -> inferred from apiKey / username+password below
  apiKey?: string; // auth "apiKey": Bearer token
  username?: string; // auth "basic"
  password?: string; // auth "basic"
}

export interface PrometheusConfig {
  default?: string;
  envs: Record<string, PrometheusEnvConfig>;
}

interface RawConfig {
  default?: string;
  envs?: Record<string, PrometheusEnvConfig>;
}

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), ".myws", "prometheus.config.json");

/** Default config path: <cwd>/.myws/prometheus.config.json (cwd = project root). */
export function defaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

/** True when the config file exists (explicit or default path). */
export function configExists(opts?: { configPath?: string }): boolean {
  const p = opts?.configPath
    ? path.resolve(process.cwd(), opts.configPath)
    : DEFAULT_CONFIG_PATH;
  return fs.existsSync(p);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Effective auth mode: the explicit "auth" field wins; otherwise infer from
 * the credential fields (apiKey -> apiKey, username/password -> basic, else none).
 */
export function resolveAuthMode(e: PrometheusEnvConfig): PrometheusAuthMode {
  if (e.auth) return e.auth;
  if (isNonEmptyString(e.apiKey)) return "apiKey";
  if (isNonEmptyString(e.username) || isNonEmptyString(e.password)) return "basic";
  return "none";
}

/** Validate one env entry; returns an actionable error message or null when valid. */
function validateEntry(name: string, e: PrometheusEnvConfig): string | null {
  if (!e || !isNonEmptyString(e.url)) {
    return `Invalid env "${name}": expected a non-empty "url".`;
  }
  const auth = resolveAuthMode(e);
  if (e.auth !== undefined && !["none", "basic", "apiKey"].includes(e.auth)) {
    return `Invalid env "${name}": "auth" must be "none", "basic" or "apiKey" (got "${e.auth}").`;
  }
  if (auth === "apiKey" && !isNonEmptyString(e.apiKey)) {
    return `Invalid env "${name}": auth "apiKey" requires a non-empty "apiKey" field (a Bearer token).`;
  }
  if (auth === "basic" && !(isNonEmptyString(e.username) && isNonEmptyString(e.password))) {
    return `Invalid env "${name}": auth "basic" requires non-empty "username" and "password".`;
  }
  if (e.timeoutMs !== undefined && (!Number.isFinite(e.timeoutMs) || e.timeoutMs <= 0)) {
    return `Invalid env "${name}": "timeoutMs" must be a positive number.`;
  }
  return null;
}

/** Load + validate the prometheus config. Throws actionable errors pointing at the CLI help. */
export function loadPrometheusConfig(opts?: { configPath?: string }): PrometheusConfig {
  const configPath = opts?.configPath
    ? path.resolve(process.cwd(), opts.configPath)
    : DEFAULT_CONFIG_PATH;

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Cannot read prometheus config at ${configPath}. ` +
        `Create .myws/prometheus.config.json (run "mycastle prometheus --help").`,
    );
  }

  let raw: RawConfig;
  try {
    raw = JSON.parse(text) as RawConfig;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON in ${configPath}: ${msg}`);
  }

  const envs = raw.envs;
  if (!envs || typeof envs !== "object" || Object.keys(envs).length === 0) {
    throw new Error(
      `Config ${configPath} has no "envs". Add at least one env (run "mycastle prometheus --help").`,
    );
  }
  for (const [name, env] of Object.entries(envs)) {
    const problem = validateEntry(name, env);
    if (problem) throw new Error(`Config ${configPath}: ${problem}`);
  }
  return { default: raw.default, envs };
}

/**
 * Resolve the --env flag to a list of env names.
 *   undefined        -> cfg.default (if valid) else first env
 *   "all"            -> every env name
 *   "a,b"            -> split on comma
 * Unknown names throw, listing the valid ones.
 */
export function resolveEnvs(cfg: PrometheusConfig, envFlag?: string): string[] {
  const valid = Object.keys(cfg.envs);
  if (!envFlag) {
    const d = cfg.default && valid.includes(cfg.default) ? cfg.default : valid[0]!;
    return [d];
  }
  if (envFlag === "all") return valid.slice();
  const names = envFlag
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`--env "${envFlag}" resolved to no envs. Valid: ${valid.join(", ")}.`);
  }
  const unknown = names.filter((n) => !valid.includes(n));
  if (unknown.length > 0) {
    throw new Error(`Unknown env: ${unknown.join(", ")}. Valid: ${valid.join(", ")}.`);
  }
  return names;
}

/** Build PrometheusClient options from one (already validated) env entry. */
export function toClientOptions(e: PrometheusEnvConfig): PrometheusClientOptions {
  const mode = resolveAuthMode(e);
  const auth: PrometheusAuth =
    mode === "apiKey"
      ? { kind: "bearer", token: e.apiKey ?? "" }
      : mode === "basic"
        ? { kind: "basic", username: e.username ?? "", password: e.password ?? "" }
        : { kind: "none" };
  return {
    baseUrl: e.url,
    basePath: e.basePath || undefined,
    auth,
    timeoutMs: e.timeoutMs,
  };
}

export interface PrometheusEnvListing {
  name: string;
  url: string;
  basePath: string;
  auth: PrometheusAuthMode;
  /** Present only for auth "basic"; the password / apiKey are never listed. */
  username?: string;
}

/**
 * Listing of all configured envs (library-level; URLs are NOT redacted here).
 * The CLI layer must redact URLs (`redactUrlCredentials`) before printing —
 * the `envs` command output carries url/basePath/auth only, never secrets.
 */
export function listEnvs(
  cfg: PrometheusConfig,
): { default: string | null; envs: PrometheusEnvListing[] } {
  const envs: PrometheusEnvListing[] = Object.entries(cfg.envs).map(([name, e]) => {
    const auth = resolveAuthMode(e);
    return {
      name,
      url: e.url,
      basePath: e.basePath ?? "",
      auth,
      ...(auth === "basic" ? { username: e.username } : {}),
    };
  });
  return { default: cfg.default ?? null, envs };
}
