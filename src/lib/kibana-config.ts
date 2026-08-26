// kibana-config.ts — load .myws/kibana.config.json and resolve the target env(s).
// Real URLs/credentials live ONLY in this gitignored file; never in code or flags.
// Never return these values to stdout; enumerate via the redacted `envs` command.

import fs from "node:fs";
import path from "node:path";

export interface KibanaEnvConfig {
  url: string;
  basePath?: string;
  timeoutMs?: number;
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface KibanaConfig {
  default?: string;
  envs: Record<string, KibanaEnvConfig>;
}

interface RawConfig {
  default?: string;
  envs?: Record<string, KibanaEnvConfig>;
}

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), ".myws", "kibana.config.json");

/** Default config path: <cwd>/.myws/kibana.config.json (cwd = workspace root). */
export function defaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

/** Load + validate the kibana config. Throws actionable errors pointing at the docs. */
export function loadKibanaConfig(opts?: { configPath?: string }): KibanaConfig {
  const configPath = opts?.configPath
    ? path.resolve(process.cwd(), opts.configPath)
    : DEFAULT_CONFIG_PATH;

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Cannot read kibana config at ${configPath}. Create .myws/kibana.config.json (run "mycastle kibana --help").`,
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
      `Config ${configPath} has no "envs". Add at least one env (run "mycastle kibana --help").`,
    );
  }
  for (const [name, env] of Object.entries(envs)) {
    if (!env || typeof env.url !== "string" || env.url.length === 0) {
      throw new Error(`Invalid env "${name}" in ${configPath}: expected { url: string, ... }.`);
    }
  }
  return { default: raw.default, envs };
}

/**
 * Resolve the --env flag to a list of env names.
 *   undefined        -> cfg.default (if valid) else first env
 *   "all"            -> every env name
 *   "dev,test"       -> split on comma
 *   "dev"            -> ["dev"]
 * Unknown names throw, listing the valid ones.
 */
export function resolveEnvs(cfg: KibanaConfig, envFlag?: string): string[] {
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
