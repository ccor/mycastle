// jenkins-config.ts — load .myws/jenkins.config.json and resolve the target env(s).
// Real URLs/credentials live ONLY in this gitignored file; never in code or flags.
// Per-env schema: { url, basePath?, username?, apiToken?, timeoutMs? } —
// username+apiToken must come as a pair (Basic auth); omit both for anonymous.
// Never return these values to stdout; enumerate via the redacted `envs` command.

import fs from "node:fs";
import path from "node:path";
import type { JenkinsClientOptions } from "./jenkins-client.js";

export type JenkinsAuthMode = "none" | "basic";

export interface JenkinsEnvConfig {
  url: string;
  basePath?: string; // reverse-proxy context path, e.g. "/jenkins"; default ""
  username?: string; // with apiToken -> Basic auth (API token, not login password)
  apiToken?: string;
  timeoutMs?: number; // default 30000 (client default)
}

export interface JenkinsConfig {
  default?: string;
  envs: Record<string, JenkinsEnvConfig>;
}

interface RawConfig {
  default?: string;
  envs?: Record<string, JenkinsEnvConfig>;
}

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), ".myws", "jenkins.config.json");

/** Default config path: <cwd>/.myws/jenkins.config.json (cwd = project root). */
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
 * Effective auth mode: username AND apiToken -> "basic" (the API token pairs
 * with the username in preemptive Basic auth); neither -> "none".
 */
export function resolveAuthMode(e: JenkinsEnvConfig): JenkinsAuthMode {
  return isNonEmptyString(e.username) && isNonEmptyString(e.apiToken) ? "basic" : "none";
}

/** Validate one env entry; returns an actionable error message or null when valid. */
function validateEntry(name: string, e: JenkinsEnvConfig): string | null {
  if (!e || !isNonEmptyString(e.url)) {
    return `Invalid env "${name}": expected a non-empty "url".`;
  }
  const hasUser = isNonEmptyString(e.username);
  const hasToken = isNonEmptyString(e.apiToken);
  if (hasUser !== hasToken) {
    return `Invalid env "${name}": "username" and "apiToken" must be set together ` +
      `(Basic auth with an API token) or both omitted (anonymous).`;
  }
  if (e.timeoutMs !== undefined && (!Number.isFinite(e.timeoutMs) || e.timeoutMs <= 0)) {
    return `Invalid env "${name}": "timeoutMs" must be a positive number.`;
  }
  return null;
}

/** Load + validate the jenkins config. Throws actionable errors pointing at the CLI help. */
export function loadJenkinsConfig(opts?: { configPath?: string }): JenkinsConfig {
  const configPath = opts?.configPath
    ? path.resolve(process.cwd(), opts.configPath)
    : DEFAULT_CONFIG_PATH;

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Cannot read jenkins config at ${configPath}. ` +
        `Create .myws/jenkins.config.json (run "mycastle jenkins --help").`,
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
      `Config ${configPath} has no "envs". Add at least one env (run "mycastle jenkins --help").`,
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
export function resolveEnvs(cfg: JenkinsConfig, envFlag?: string): string[] {
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

/** Build JenkinsClient options from one (already validated) env entry. */
export function toClientOptions(e: JenkinsEnvConfig): JenkinsClientOptions {
  return {
    baseUrl: e.url,
    basePath: e.basePath || undefined,
    username: e.username,
    apiToken: e.apiToken,
    timeoutMs: e.timeoutMs,
  };
}

export interface JenkinsEnvListing {
  name: string;
  url: string;
  basePath: string;
  auth: JenkinsAuthMode;
  /** Present only for auth "basic"; the apiToken is never listed. */
  username?: string;
}

/**
 * Listing of all configured envs (library-level; URLs are NOT redacted here).
 * The CLI layer must redact URLs (`redactUrlCredentials`) before printing —
 * the `envs` command output carries url/basePath/auth only, never apiToken.
 */
export function listEnvs(
  cfg: JenkinsConfig,
): { default: string | null; envs: JenkinsEnvListing[] } {
  const envs: JenkinsEnvListing[] = Object.entries(cfg.envs).map(([name, e]) => {
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
