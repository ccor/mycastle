// yapi-config.ts — load .myws/yapi.config.json and resolve the target env/auth.
// Real URLs/credentials live ONLY in this gitignored file; never in code or flags.
//
// Two auth modes:
//   token   — per-project openapi token (tokens[projectId]); stateless.
//   session — YApi account login (username/password) -> cookie session persisted
//             per env; one login covers every project the account can access.
// When both are configured, an explicit project with a token prefers the token;
// otherwise session wins (it is the "one login, all projects" mode).

import fs from "node:fs";
import path from "node:path";

export interface YapiEnvConfig {
  url: string;
  /** projectId (as string) -> project token. Optional when username/password set. */
  tokens?: Record<string, string>;
  /** YApi account email (session mode). Requires password. */
  username?: string;
  /** YApi account password (session mode). Requires username. */
  password?: string;
}

export interface YapiConfig {
  default?: string;
  envs: Record<string, YapiEnvConfig>;
}

/** Resolved auth plan for one (env, project) pair. */
export type YapiAuth =
  | { mode: "token"; projectId: string; token: string }
  | { mode: "session"; username: string; password: string; projectId?: string };

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), ".myws", "yapi.config.json");

/** Default config path: <cwd>/.myws/yapi.config.json (cwd = project root). */
export function defaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

/** Load + validate the yapi config. Throws actionable errors pointing at the CLI help. */
export function loadYapiConfig(opts?: { configPath?: string }): YapiConfig {
  const configPath = opts?.configPath
    ? path.resolve(process.cwd(), opts.configPath)
    : DEFAULT_CONFIG_PATH;

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Cannot read yapi config at ${configPath}. Create .myws/yapi.config.json (run "mycastle yapi --help").`,
    );
  }

  let raw: YapiConfig;
  try {
    raw = JSON.parse(text) as YapiConfig;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON in ${configPath}: ${msg}`);
  }

  const envs = raw.envs;
  if (!envs || typeof envs !== "object" || Object.keys(envs).length === 0) {
    throw new Error(
      `Config ${configPath} has no "envs". Add at least one env (run "mycastle yapi --help").`,
    );
  }
  for (const [name, env] of Object.entries(envs)) {
    if (!env || typeof env.url !== "string") {
      throw new Error(`Invalid env "${name}" in ${configPath}: expected {url, ...}.`);
    }
    const hasSession =
      typeof env.username === "string" && env.username.length > 0 &&
      typeof env.password === "string" && env.password.length > 0;
    const hasPartialSession =
      (env.username !== undefined && env.username.length > 0) !==
      (env.password !== undefined && env.password.length > 0);
    if (hasPartialSession) {
      throw new Error(
        `Env "${name}" in ${configPath}: username and password must be configured together (session mode).`,
      );
    }
    if (env.tokens !== undefined) {
      if (typeof env.tokens !== "object" || env.tokens === null) {
        throw new Error(`Env "${name}" in ${configPath}: "tokens" must be an object {projectId: token}.`);
      }
      for (const [pid, token] of Object.entries(env.tokens)) {
        if (typeof token !== "string" || token.length === 0) {
          throw new Error(`Invalid token for project "${pid}" in env "${name}": expected a non-empty string.`);
        }
      }
    }
    if (!hasSession && (!env.tokens || Object.keys(env.tokens).length === 0)) {
      throw new Error(
        `Env "${name}" in ${configPath}: configure session (username+password) and/or tokens {projectId: token}.`,
      );
    }
  }
  return { default: raw.default, envs };
}

/** Resolve the --env flag to a list of env names (same rules as xxljob). */
export function resolveEnvs(cfg: YapiConfig, envFlag?: string): string[] {
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

/**
 * Resolve how to authenticate one call.
 *   projectFlag given -> that project's token if configured, else session (with
 *   the project id attached).
 *   omitted           -> session when configured (projectId unknown), else the
 *   single configured token; multiple tokens without session is ambiguous.
 */
export function resolveAuth(env: YapiEnvConfig, projectFlag?: string): YapiAuth {
  const sessionOk =
    typeof env.username === "string" && env.username.length > 0 &&
    typeof env.password === "string" && env.password.length > 0;
  const tokenIds = Object.keys(env.tokens ?? {});

  if (projectFlag !== undefined) {
    const tok = env.tokens?.[projectFlag];
    if (tok !== undefined) return { mode: "token", projectId: projectFlag, token: tok };
    if (sessionOk) {
      return { mode: "session", username: env.username!, password: env.password!, projectId: projectFlag };
    }
    throw new Error(
      `Unknown project "${projectFlag}" (no token configured for it). Configured projects: ${tokenIds.join(", ") || "(none)"}.`,
    );
  }

  if (sessionOk) return { mode: "session", username: env.username!, password: env.password! };
  if (tokenIds.length === 1) {
    return { mode: "token", projectId: tokenIds[0]!, token: env.tokens![tokenIds[0]!]! };
  }
  throw new Error(
    `--project <id> required (multiple token projects configured). Configured: ${tokenIds.join(", ")}.`,
  );
}
