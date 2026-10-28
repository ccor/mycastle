// archery.ts — thin CLI over src/lib/archery-client.js.
// Query/browse paths are read-only; `workflow submit` creates an upline ticket
// (pending review) and requires an explicit --yes.
//
//   mycastle archery <command> [args] [--env test|all|a,b] [options]
//
// Commands:
//   envs                              list envs: name + url + username (never passwords)
//   login / logout                    login (persist session) / logout (clear session)
//   status                            connectivity / auth probe
//   instances [--tag can_read|can_execute|can_audit|can_modify]   instances the current user can access (default can_read)
//   workflow list [--status --instance --group --from --to --search --limit --offset]
//   workflow groups                   groups usable for submit (from /submitsql/ dropdown)
//   workflow sqlcheck --instance <name|id> --db <db> (--sql '<sql>' | --sql-file <path>)
//   workflow submit   --instance <name|id> --db <db> --group-id N --name '<ticket>' (--sql | --sql-file <path>) [--backup] [--demand-url U] [--yes]
//   workflow content  --workflow-id N  audited statements of a ticket
//   querylog list [--limit --offset --search]
//   databases   --instance <name>
//   tables      --instance <name> --db <db>
//   columns     --instance <name> --db <db> --table <tb>
//   describe    --instance <name> --db <db> --table <tb>
//   query       --instance <name> --db <db> --sql '<sql>' [--table <tb>] [--limit N]
//
// Secrets are read ONLY from .myws/archery.config.json (gitignored), never from flags.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadArcheryConfig, resolveEnvs, type ArcheryConfig } from "./lib/archery-config.js";
import {
  ArcheryClient,
  INSTANCE_TAGS,
  stripNonTicketStatements,
  type InstanceTag,
} from "./lib/archery-client.js";
import { redactUrlCredentials } from "./lib/redact.js";

interface CliArgs {
  rest: string[];
  env?: string;
  configPath?: string;
  compact: boolean;
  help: boolean;
  /** per-request HTTP timeout in ms (default 30000); useful for slow prd aggregates */
  timeoutMs?: number;
}

const HELP = `archery — Archery data-side CLI (JSON to stdout)

Usage:
  mycastle archery <command> [args] [options]

Commands:
  envs                              list envs: name + url + username (never passwords)
  login / logout                    login (persist session) / logout (clear session)
  status                            connectivity / auth probe
  instances [--tag T]               instances the current user can access (T = can_read|can_execute|can_audit|can_modify; default can_read)
  workflow list [--status S] [--instance <name|id>] [--group <name|id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--search Q] [--limit N] [--offset N]
  workflow groups                   groups usable for workflow submit (name -> id)
  workflow sqlcheck --instance <name|id> --db <db> (--sql '<sql>' | --sql-file <path>)
                                    server-side audit only; no ticket created
  workflow submit --instance <name|id> --db <db> --group-id N --name '<ticket>'
                  (--sql '<sql>' | --sql-file <path>) [--backup] [--demand-url U] [--yes]
                                    WITHOUT --yes: dry-run (audit only, no ticket);
                                    audit errors/critical abort submission
  workflow content --workflow-id N  audited statements of an existing ticket
  workflow execute --workflow-id N [--mode auto|manual] [--yes]
                                    run the audited SQL now (detail-page form);
                                    without --yes: dry-run only
  workflow cancel  --workflow-id N [--remark '<why>'] [--yes]
                                    abort a pending workflow (detail-page form)
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
  --timeout <ms>         per-request HTTP timeout (default 30000); raise for slow prd aggregates

Secrets come only from .myws/archery.config.json (gitignored); never from flags.
\`query\` runs user-supplied SQL; Archery enforces SELECT-only server-side.
\`workflow submit\` only creates a ticket (status workflow_manreviewing); execution
still needs the review/approve/execute flow on the platform.
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
      case "--timeout":
        a.timeoutMs = num2(next());
        break;
      default:
        a.rest.push(arg);
    }
  }
  return a;
}

function num2(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout expects a positive integer (ms)`);
  return n;
}

function print(value: unknown, compact: boolean): void {
  console.log(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

/** Parse --key value tokens. Boolean flags (--yes etc.) take no value: a missing
 *  value or a value that starts with "--" marks the flag as boolean "true". */
function parseFlags(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      const v = tokens[i + 1];
      if (v === undefined || v.startsWith("--")) {
        out[t.slice(2)] = "true";
      } else {
        out[t.slice(2)] = v;
        i++;
      }
    }
  }
  return out;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve --instance (name or numeric id) to the numeric instance id. */
async function resolveInstanceId(client: ArcheryClient, nameOrId: string): Promise<number> {
  if (/^\d+$/.test(nameOrId)) return Number.parseInt(nameOrId, 10);
  for (const tag of ["can_execute", "can_read"] as InstanceTag[]) {
    const env = await client.instances.list(tag);
    const hit = env.data.find((i) => i.instance_name === nameOrId);
    if (hit) return hit.id;
  }
  throw new Error(
    `instance "${nameOrId}" not found for env=${client.env} (list via: mycastle archery instances)`,
  );
}

/** SQL text from --sql or --sql-file (exactly one required). */
function loadSqlInput(f: Record<string, string>, usage: string): string {
  const hasFile = f["sql-file"] !== undefined;
  const hasSql = f.sql !== undefined;
  if (hasFile === hasSql) throw new Error(`provide exactly one of --sql '<sql>' | --sql-file <path>\n${usage}`);
  if (hasFile) {
    const p = path.resolve(f["sql-file"]!);
    const text = fs.readFileSync(p, "utf8");
    if (!text.trim()) throw new Error(`sql file is empty: ${p}`);
    return text;
  }
  const sql = f.sql!.trim();
  if (!sql) throw new Error("--sql must not be empty");
  return sql;
}

/** SQL for a workflow ticket. Default strips txn-control / SET NAMES statements
 *  (Archery rejects them and manages its own transaction) while keeping comments
 *  attached to their statements; --raw keeps everything verbatim. */
function ticketSqlInput(f: Record<string, string>, usage: string): string {
  const sql = loadSqlInput(f, usage);
  if (f.raw === "true") return sql;
  const kept = stripNonTicketStatements(sql);
  if (kept.length === 0) throw new Error("no statements left after stripping BEGIN/COMMIT/SET NAMES");
  return kept.join("\n\n");
}

/** Run one command against one env. Returns JSON-serializable data (or throws). */
async function runEnv(
  command: string,
  cmdArgs: string[],
  envName: string,
  cfg: ArcheryConfig,
  timeoutMs?: number,
): Promise<unknown> {
  const envCfg = cfg.envs[envName]!;
  const client = new ArcheryClient({
    env: envName,
    baseUrl: envCfg.url,
    username: envCfg.username,
    password: envCfg.password,
    timeoutMs,
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
      const f = parseFlags(rest);
      switch (sub) {
        case "list": {
          let instanceId = num(f["instance-id"]);
          if (instanceId === undefined && f.instance !== undefined) {
            instanceId = await resolveInstanceId(client, f.instance);
          }
          let groupId = num(f.group);
          if (groupId === undefined && f.group !== undefined) {
            const groups = await client.workflow.groups();
            const hit = groups.find((g) => g.name === f.group);
            if (!hit) {
              throw new Error(
                `group "${f.group}" not found; available: ${groups.map((g) => `${g.name}=${g.id}`).join(", ")}`,
              );
            }
            groupId = hit.id;
          }
          return client.workflow.list({
            status: f.status,
            instanceId,
            groupId,
            fromDate: f.from,
            toDate: f.to,
            search: f.search,
            limit: num(f.limit),
            offset: num(f.offset),
          });
        }
        case "groups":
          return client.workflow.groups();
        case "sqlcheck": {
          const usage = "usage: workflow sqlcheck --instance <name|id> --db <db> (--sql '<sql>' | --sql-file <path>) [--raw]";
          if (!f.instance || !f.db) throw new Error(usage);
          const instanceId = await resolveInstanceId(client, f.instance);
          const fullSql = ticketSqlInput(f, usage);
          return client.workflow.sqlcheck({ instanceId, db: f.db, fullSql });
        }
        case "submit": {
          const usage =
            "usage: workflow submit --instance <name|id> --db <db> --group-id N --name '<ticket>' " +
            "(--sql '<sql>' | --sql-file <path>) [--backup] [--demand-url U] [--yes]";
          if (!f.instance || !f.db || !f.name || !f["group-id"]) throw new Error(usage);
          const instanceId = await resolveInstanceId(client, f.instance);
          const fullSql = ticketSqlInput(f, usage);
          const groupId = num(f["group-id"])!;
          // Audit first; hard-fail on errors/critical so a broken script never
          // turns into a pending ticket.
          const check = await client.workflow.sqlcheck({ instanceId, db: f.db, fullSql });
          const errCount = check.error_count ?? 0;
          if (errCount > 0 || check.is_critical === true || check.error) {
            return {
              submitted: false,
              reason: "sqlcheck reported errors; fix the SQL and retry",
              errorCount: errCount,
              isCritical: check.is_critical ?? false,
              check,
            };
          }
          if (f.yes !== "true") {
            return {
              submitted: false,
              dryRun: true,
              warningCount: check.warning_count ?? 0,
              check,
              hint: "sqlcheck passed; re-run with --yes to create the ticket",
            };
          }
          const r = await client.workflow.submit({
            name: f.name,
            groupId,
            instanceId,
            db: f.db,
            sql: fullSql,
            isBackup: f.backup === "true",
            demandUrl: f["demand-url"],
          });
          return {
            submitted: true,
            workflowId: r.workflow_id,
            status: r.workflow?.status ?? null,
            name: r.workflow?.workflow_name ?? f.name,
            detailUrl: `${client.baseUrl}/detail/${r.workflow_id}/`,
            raw: r,
          };
        }
        case "content": {
          const id = num(f["workflow-id"]);
          if (!id) throw new Error("usage: workflow content --workflow-id N");
          return client.workflow.detailContent(id);
        }
        case "execute": {
          const id = num(f["workflow-id"]);
          if (!id) throw new Error("usage: workflow execute --workflow-id N [--mode auto|manual] [--yes]");
          const mode = f.mode === "manual" ? "manual" : "auto";
          if (f.yes !== "true") {
            return {
              executed: false,
              dryRun: true,
              workflowId: id,
              mode,
              detailUrl: `${client.baseUrl}/detail/${id}/`,
              hint: "add --yes to run the audited SQL now (verify after via: workflow content --workflow-id <id>)",
            };
          }
          const probe = await client.workflow.execute(id, mode);
          return {
            executed: true,
            workflowId: id,
            mode,
            ...probe,
            hint: `verify outcome: mycastle archery workflow content --workflow-id ${id} --env ${client.env}`,
          };
        }
        case "cancel": {
          const id = num(f["workflow-id"]);
          if (!id) throw new Error("usage: workflow cancel --workflow-id N [--remark '<why>'] [--yes]");
          const remark = f.remark ?? "";
          if (f.yes !== "true") {
            return {
              cancelled: false,
              dryRun: true,
              workflowId: id,
              remark,
              detailUrl: `${client.baseUrl}/detail/${id}/`,
              hint: "add --yes to abort this workflow",
            };
          }
          const probe = await client.workflow.cancel(id, remark);
          return { cancelled: true, workflowId: id, remark, ...probe };
        }
        default:
          throw new Error(
            "usage: workflow list|groups|sqlcheck|submit|content|execute|cancel (see help)",
          );
      }
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

  // "envs" lists names + redacted url + username — no live connection, no
  // passwords printed; agents never need to read the config file raw.
  if (command === "envs") {
    const cfg = loadArcheryConfig({ configPath: args.configPath });
    const names = Object.keys(cfg.envs);
    const def = cfg.default && names.includes(cfg.default) ? cfg.default : (names[0] ?? null);
    const envs = names.map((name) => ({
      name,
      url: redactUrlCredentials(cfg.envs[name]!.url),
      username: cfg.envs[name]!.username,
      isDefault: name === def,
    }));
    print({ default: def, envs }, args.compact);
    return;
  }

  const cfg = loadArcheryConfig({ configPath: args.configPath });
  const envNames = resolveEnvs(cfg, args.env);

  const results: Record<string, unknown> = {};
  for (const envName of envNames) {
    try {
      results[envName] = await runEnv(command, cmdArgs, envName, cfg, args.timeoutMs);
    } catch (e) {
      results[envName] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  print(results, args.compact);
}
