// kibana.ts — thin read-only CLI over src/lib/kibana-client.js.
//
//   mycastle kibana <command> [args] [--env dev|test|prd|all|a,b] [options]
//
// Commands:
//   envs                    list configured env names (no secrets)
//   status                  GET /api/status (connectivity / auth probe)
//   spaces list             list all spaces
//   spaces get <id>         get one space
//   data-views list         list all data views (index patterns)
//   data-views get <id>     get one data view
//   get <path>              GET any read endpoint, e.g. "/api/saved_objects/_find?type=dashboard"
//
// Secrets are read ONLY from .myws/kibana.config.json (gitignored), never from flags.

import { KibanaClient, resolveAuth } from "./lib/kibana-client.js";
import {
  loadKibanaConfig,
  resolveEnvs,
  type KibanaConfig,
  type KibanaEnvConfig,
} from "./lib/kibana-config.js";

interface CliArgs {
  rest: string[];
  env?: string;
  configPath?: string;
  compact: boolean;
  help: boolean;
}

const HELP = `kibana — read-only Kibana API CLI (JSON to stdout)

Usage:
  mycastle kibana <command> [args] [options]

Commands:
  envs                    list configured env names (no secrets)
  status                  GET /api/status (connectivity / auth probe)
  spaces list             list all spaces
  spaces get <id>         get one space
  data-views list         list all data views (index patterns)
  data-views get <id>     get one data view
  get <path>              GET any read endpoint, e.g. "/api/saved_objects/_find?type=dashboard"

Options:
  --env <name|all|a,b>   target env(s); default = config "default" or first env
  --config <path>        override .myws/kibana.config.json
  --compact              single-line JSON (default: pretty)
  -h, --help             show this help

Secrets come only from .myws/kibana.config.json (gitignored); never from flags.
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

/** Build a KibanaClient from a config-file env entry. */
function clientFromEnvConfig(envCfg: KibanaEnvConfig): KibanaClient {
  return new KibanaClient({
    baseUrl: envCfg.url,
    basePath: envCfg.basePath,
    timeoutMs: envCfg.timeoutMs,
    auth: resolveAuth(envCfg),
  });
}

/**
 * Run one command against one env. Returns JSON-serializable data (or throws).
 */
async function runEnv(
  command: string,
  cmdArgs: string[],
  envName: string,
  cfg: KibanaConfig,
): Promise<unknown> {
  const envCfg = cfg.envs[envName]!;
  const client = clientFromEnvConfig(envCfg);
  switch (command) {
    case "status":
      return client.status();
    case "spaces": {
      const [sub = "", id] = cmdArgs;
      if (sub === "list") return client.spaces.list();
      if (sub === "get") {
        if (!id) throw new Error("usage: spaces get <id>");
        return client.spaces.get(id);
      }
      throw new Error("usage: spaces <list | get <id>>");
    }
    case "data-views": {
      const [sub = "", id] = cmdArgs;
      if (sub === "list") return client.dataViews.list();
      if (sub === "get") {
        if (!id) throw new Error("usage: data-views get <id>");
        return client.dataViews.get(id);
      }
      throw new Error("usage: data-views <list | get <id>>");
    }
    case "get": {
      const [path] = cmdArgs;
      if (!path) throw new Error("usage: get <path>");
      return client.get(path);
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
  const known = new Set(["envs", "status", "spaces", "data-views", "get"]);
  if (!known.has(command)) {
    console.error(HELP);
    console.error(`error: unknown command: ${command}`);
    process.exit(2);
  }

  // "envs" lists configured env names only — no live connection, no secrets printed.
  if (command === "envs") {
    const cfg = loadKibanaConfig({ configPath: args.configPath });
    const envs = Object.keys(cfg.envs);
    print({ default: cfg.default ?? envs[0] ?? null, envs }, args.compact);
    return;
  }

  const cfg = loadKibanaConfig({ configPath: args.configPath });
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
