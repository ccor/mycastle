// archery-config.ts — load .myws/archery.config.json and resolve the target env(s).
// Real URLs/credentials live ONLY in this gitignored file; never in code or flags.

import fs from "node:fs";
import path from "node:path";

export interface ArcheryEnvConfig {
  url: string;
  username: string;
  password: string;
}

export interface ArcheryConfig {
  default?: string;
  envs: Record<string, ArcheryEnvConfig>;
}

interface RawConfig {
  default?: string;
  envs?: Record<string, ArcheryEnvConfig>;
}

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), ".myws", "archery.config.json");

/** Default config path: <cwd>/.myws/archery.config.json (cwd = workspace root). */
export function defaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

/** Load + validate the archery config. Throws actionable errors pointing at the docs. */
export function loadArcheryConfig(opts?: { configPath?: string }): ArcheryConfig {
  const configPath = opts?.configPath
    ? path.resolve(process.cwd(), opts.configPath)
    : DEFAULT_CONFIG_PATH;

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Cannot read archery config at ${configPath}. Create .myws/archery.config.json (run "mycastle archery --help").`,
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
      `Config ${configPath} has no "envs". Add at least one env (run "mycastle archery --help").`,
    );
  }
  for (const [name, env] of Object.entries(envs)) {
    if (
      !env ||
      typeof env.url !== "string" ||
      typeof env.username !== "string" ||
      typeof env.password !== "string"
    ) {
      throw new Error(`Invalid env "${name}" in ${configPath}: expected {url, username, password}.`);
    }
  }
  return { default: raw.default, envs };
}

/**
 * Resolve the --env flag to a list of env names.
 *   undefined        -> cfg.default (if valid) else first env
 *   "all"            -> every env name
 *   "test,dev"       -> split on comma
 *   "test"           -> ["test"]
 * Unknown names throw, listing the valid ones.
 */
export function resolveEnvs(cfg: ArcheryConfig, envFlag?: string): string[] {
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
  // If "all" appears after split (e.g., "all,"), it's a user error - treat as no valid envs
  if (names.length === 1 && names[0] === "all") {
    throw new Error(`--env "${envFlag}" resolved to no envs. Valid: ${valid.join(", ")}.`);
  }
  const unknown = names.filter((n) => !valid.includes(n));
  if (unknown.length > 0) {
    throw new Error(`Unknown env: ${unknown.join(", ")}. Valid: ${valid.join(", ")}.`);
  }
  return names;
}
