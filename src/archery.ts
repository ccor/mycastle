// archery.ts — thin read-only CLI over src/lib/archery-client.js.
//
//   mycastle archery <command> [args] [--env test|all|a,b] [options]
//
// Commands:
//   envs                              list configured env names (no secrets)
//   login / logout                    login (persist session) / logout (clear session)
//   status                            connectivity / auth probe
//   instances [--tag can_read|can_execute|can_audit|can_modify]   instances the current user can access (default can_read)
//   workflow list [--status --instance-id --group --from --to --search --limit --offset]
//   querylog list [--limit --offset --search]
//   databases   --instance <name>
//   tables      --instance <name> --db <db>
//   columns     --instance <name> --db <db> --table <tb>
//   describe    --instance <name> --db <db> --table <tb>
//   query       --instance <name> --db <db> --sql '<sql>' [--table <tb>] [--limit N]
//
// Secrets are read ONLY from .myws/archery.config.json (gitignored), never from flags.

import { loadArcheryConfig, resolveEnvs, type ArcheryConfig } from "./lib/archery-config.js";
import { ArcheryClient, INSTANCE_TAGS, type InstanceTag } from "./lib/archery-client.js";

interface CliArgs {
  rest: string[];
  env?: string;
  configPath?: string;
  compact: boolean;
  help: boolean;
}

const HELP = `archery — read-only Archery data-side CLI (JSON to stdout)

Usage:
  mycastle archery <command> [args] [options]

Commands:
  envs                              list configured env names (no secrets)
  login / logout                    login (persist session) / logout (clear session)
  status                            connectivity / auth probe
  instances [--tag T]               instances the current user can access (T = can_read|can_execute|can_audit|can_modify; default can_read)
  workflow list [--status S] [--instance-id N] [--group N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--search Q] [--limit N] [--offset N]
  querylog list [--limit N] [--offset N] [--search Q]
  databases   --instance <name>
  tables      --instance <name> --db <db>
  columns     --instance <name> --db <db> --table <tb>
  describe    --instance <name> --db <db> --table <tb>
  query       --instance <name> --db <db> --sql '<sql>' [--table <tb>] [--limit N]

Options:
  --env <name|all|a,b>   target env(s); default = config "default" or first env
  --config <path>        override .myws/archery.config.json
  --compact              single-line JSON (default: pretty)
  -h, --help             show this help

Secrets come only from .myws/archery.config.json (gitignored); never from flags.
\`query\` runs user-supplied SQL; Archery enforces SELECT-only server-side.
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

function num(v: string | undefined): number | undefined {
  return v === undefined ? undefined : Number.parseInt(v, 10);
}

/** Run one command against one env. Returns JSON-serializable data (or throws). */
async function runEnv(
  command: string,
  cmdArgs: string[],
  envName: string,
  cfg: ArcheryConfig,
): Promise<unknown> {
  const envCfg = cfg.envs[envName]!;
  const client = new ArcheryClient({
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
    case "instances": {
      const f = parseFlags(cmdArgs);
      const tag = f.tag ?? "can_read";
      if (!INSTANCE_TAGS.includes(tag as InstanceTag)) {
        throw new Error(`invalid --tag "${tag}"; one of: ${INSTANCE_TAGS.join(", ")}`);
      }
      return client.instances.list(tag as InstanceTag);
    }
    case "workflow": {
      const [sub = "", ...rest] = cmdArgs;
      if (sub !== "list") throw new Error("usage: workflow list [filters...]");
      const f = parseFlags(rest);
      return client.workflow.list({
        status: f.status,
        instanceId: num(f["instance-id"]),
        groupId: num(f.group),
        fromDate: f.from,
        toDate: f.to,
        search: f.search,
        limit: num(f.limit),
        offset: num(f.offset),
      });
    }
    case "querylog": {
      const [sub = "", ...rest] = cmdArgs;
      if (sub !== "list") throw new Error("usage: querylog list [filters...]");
      const f = parseFlags(rest);
      return client.querylog.list({ limit: num(f.limit), offset: num(f.offset), search: f.search });
    }
    case "databases": {
      const f = parseFlags(cmdArgs);
      if (!f.instance) throw new Error("usage: databases --instance <name>");
      return client.instance.databases(f.instance);
    }
    case "tables": {
      const f = parseFlags(cmdArgs);
      if (!f.instance || !f.db) throw new Error("usage: tables --instance <name> --db <db>");
      return client.instance.tables(f.instance, f.db);
    }
    case "columns": {
      const f = parseFlags(cmdArgs);
      if (!f.instance || !f.db || !f.table) {
        throw new Error("usage: columns --instance <name> --db <db> --table <tb>");
      }
      return client.instance.columns(f.instance, f.db, f.table);
    }
    case "describe": {
      const f = parseFlags(cmdArgs);
      if (!f.instance || !f.db || !f.table) {
        throw new Error("usage: describe --instance <name> --db <db> --table <tb>");
      }
      return client.instance.describe(f.instance, f.db, f.table);
    }
    case "query": {
      const f = parseFlags(cmdArgs);
      if (!f.instance || !f.db || !f.sql) {
        throw new Error(
          "usage: query --instance <name> --db <db> --sql '<sql>' [--table <tb>] [--limit N]",
        );
      }
      return client.query.run({
        instance: f.instance,
        db: f.db,
        sql: f.sql,
        table: f.table,
        limit: num(f.limit),
      });
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
  const known = new Set([
    "envs", "login", "logout", "status", "instances",
    "workflow", "querylog", "databases", "tables", "columns", "describe", "query",
  ]);
  if (!known.has(command)) {
    console.error(HELP);
    console.error(`error: unknown command: ${command}`);
    process.exit(2);
  }

  // "envs" lists configured env names only — no live connection, no secrets printed.
  if (command === "envs") {
    const cfg = loadArcheryConfig({ configPath: args.configPath });
    const envs = Object.keys(cfg.envs);
    print({ default: cfg.default ?? envs[0] ?? null, envs }, args.compact);
    return;
  }

  const cfg = loadArcheryConfig({ configPath: args.configPath });
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
