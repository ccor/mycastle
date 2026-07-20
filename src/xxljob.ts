// xxljob.ts — thin read-only CLI over src/lib/xxljob-client.js.
//
//   mycastle xxljob <command> [args] [--env dev|test|prd|all|a,b] [options]
//
// Commands:
//   envs                    list configured env names (no secrets)
//   login / logout          login (persist cookie) / logout (clear cookie)
//   status                  connectivity / auth probe
//   executors list          list executors (jobGroup)
//   jobs list [--group N] [--status -1|0|1] [--handler H]
//   jobs get <id>
//   jobs log <id> [--group N] [--status -1|0|1|2]
//   snapshot                snapshot executors + jobs to local JSON
//
// Secrets are read ONLY from .myws/xxljob.config.json (gitignored), never from flags.

import fs from "node:fs";
import path from "node:path";
import { loadXxljobConfig, resolveEnvs, type XxljobConfig } from "./lib/xxljob-config.js";
import { XxljobClient, type Snapshot } from "./lib/xxljob-client.js";
import { configDir, ensureDir } from "./lib/platform.js";

interface CliArgs {
  rest: string[];
  env?: string;
  configPath?: string;
  compact: boolean;
  help: boolean;
}

const HELP = `xxljob — read-only XXL-Job admin CLI (JSON to stdout)

Usage:
  mycastle xxljob <command> [args] [options]

Commands:
  envs                    list configured env names (no secrets)
  login / logout          login (persist cookie) / logout (clear cookie)
  status                  connectivity / auth probe
  executors list          list executors
  jobs list [--group N] [--status -1|0|1] [--handler H]
  jobs get <id>
  jobs log <id> [--group N] [--status -1|0|1|2]
  snapshot                snapshot executors + jobs to local JSON

Options:
  --env <name|all|a,b>   target env(s); default = config "default" or first env
  --config <path>        override .myws/xxljob.config.json
  --compact              single-line JSON (default: pretty)
  -h, --help             show this help

Secrets come only from .myws/xxljob.config.json (gitignored); never from flags.
`;

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { rest: [], compact: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "--env":
        a.env = next();
        break;
      case "--config":
        a.configPath = next();
        break;
      case "--compact":
        a.compact = true;
        break;
      default:
        a.rest.push(arg);
    }
  }
  return a;
}

function print(value: unknown, compact: boolean): void {
  console.log(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

/** Parse --key value tokens (no positionals). Throws on a missing value. */
function parseFlags(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      const v = tokens[++i];
      if (v === undefined) throw new Error(`${t} requires a value`);
      out[t.slice(2)] = v;
    }
  }
  return out;
}

function parseJobsListFlags(tokens: string[]): { group?: number; status?: number; handler?: string } {
  const f = parseFlags(tokens);
  const num = (v: string | undefined): number | undefined =>
    v === undefined ? undefined : Number.parseInt(v, 10);
  return { group: num(f.group), status: num(f.status), handler: f.handler };
}

function parseJobsLogFlags(tokens: string[]): { group?: number; status?: number } {
  const f = parseFlags(tokens);
  const num = (v: string | undefined): number | undefined =>
    v === undefined ? undefined : Number.parseInt(v, 10);
  return { group: num(f.group), status: num(f.status) };
}

/** Write a snapshot to <configDir>/xxljob/snapshots/<env>/<YYYYMMDDTHHMMSSZ>.json; return the path. */
function writeSnapshotFile(snap: Snapshot): string {
  const ts = snap.takenAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20260630T120000Z
  const dir = path.join(configDir, "xxljob", "snapshots", snap.env);
  ensureDir(dir);
  const file = path.join(dir, `${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2), "utf8");
  return file;
}

/**
 * Run one command against one env. Later tasks add `case` arms; until then an
 * unimplemented command throws. Returns JSON-serializable data (or throws).
 */
async function runEnv(
  command: string,
  cmdArgs: string[],
  envName: string,
  cfg: XxljobConfig,
): Promise<unknown> {
  const envCfg = cfg.envs[envName]!;
  const client = new XxljobClient({
    env: envName,
    baseUrl: envCfg.url,
    username: envCfg.username,
    password: envCfg.password,
  });
  switch (command) {
    case "login":
      await client.login();
      return { env: envName, login: true };
    case "logout":
      await client.logout();
      return { env: envName, logout: true };
    case "status":
      return client.status();
    case "executors": {
      const [sub = ""] = cmdArgs;
      if (sub !== "list") throw new Error("usage: executors list");
      return client.executors.list();
    }
    case "jobs": {
      const [sub = "", ...rest] = cmdArgs;
      if (sub === "list") return client.jobs.list(parseJobsListFlags(rest));
      if (sub === "get") {
        const id = Number.parseInt(rest[0] ?? "", 10);
        if (!Number.isFinite(id)) throw new Error("usage: jobs get <id>");
        return client.jobs.get(id);
      }
      if (sub === "log") {
        const id = Number.parseInt(rest[0] ?? "", 10);
        if (!Number.isFinite(id)) {
          throw new Error("usage: jobs log <id> [--group N] [--status -1|0|1|2]");
        }
        const flags = parseJobsLogFlags(rest.slice(1));
        if (flags.group === undefined) {
          throw new Error("jobs log requires --group <id> (run `executors list`)");
        }
        return client.jobs.log(id, { group: flags.group, status: flags.status });
      }
      throw new Error("usage: jobs <list | get <id> | log <id> [--group N]>");
    }
    case "snapshot": {
      const snap = await client.snapshot();
      const file = writeSnapshotFile(snap);
      console.error(`snapshot[${envName}] -> ${file}`);
      return snap;
    }
    default:
      throw new Error(`command "${command}" not implemented yet`);
  }
}

export async function run(argv: string[]): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(HELP);
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  if (args.help || args.rest.length === 0) {
    console.log(HELP);
    return;
  }

  const [command = "", ...cmdArgs] = args.rest;
  const known = new Set(["envs", "login", "logout", "status", "executors", "jobs", "snapshot"]);
  if (!known.has(command)) {
    console.error(HELP);
    console.error(`error: unknown command: ${command}`);
    process.exit(2);
  }

  // "envs" lists configured env names only — no live connection, no secrets printed.
  if (command === "envs") {
    const cfg = loadXxljobConfig({ configPath: args.configPath });
    const envs = Object.keys(cfg.envs);
    print({ default: cfg.default ?? envs[0] ?? null, envs }, args.compact);
    return;
  }

  const cfg = loadXxljobConfig({ configPath: args.configPath });
  const envNames = resolveEnvs(cfg, args.env);

  const results: Record<string, unknown> = {};
  for (const envName of envNames) {
    try {
      results[envName] = await runEnv(command, cmdArgs, envName, cfg);
    } catch (e) {
      results[envName] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  print(results, args.compact);
}
