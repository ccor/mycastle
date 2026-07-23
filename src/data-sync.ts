#!/usr/bin/env node
// data-sync.ts — copy table data from a Source (archery | mysql) to a mysql Dest.
//
//   npx tsx tools/data-sync.ts copy \
//     --src archery|mysql \
//     --src-env <env>          (archery) \
//     --src-instance "<name>"  (archery) \
//     --src-conn <name>        (mysql) \
//     --src-db <db> \
//     --dst-conn <name> \
//     --dst-db <db> \
//     --tables t1,t2,t3 | src:dst,src:dst \
//     [--mode truncate|append]      default: truncate \
//     [--pk <col>]                  default: auto-discover single-col PK \
//     [--page-size N]               default: 1000 \
//     [--batch N]                   default: 200 \
//     [--max-pages N]               default: 1000 \
//     [--yes]                       skip confirm prompt for non-empty dest \
//     [--dry-run]                   count both sides only, no writes \
//     [--compact]
//
// Secrets come ONLY from .myws/archery.config.json / .myws/db.config.json.

import process from "node:process";

import {
  openDest,
  openSource,
  parseTableList,
  syncTables,
  type SyncMode,
} from "./lib/data-sync.js";

interface CliArgs {
  command: string;
  srcKind?: "archery" | "mysql";
  srcEnv?: string;
  srcInstance?: string;
  srcConn?: string;
  srcDb?: string;
  dstConn?: string;
  dstDb?: string;
  tables?: string;
  mode: SyncMode;
  pk?: string;
  pageSize: number;
  batch: number;
  maxPages: number;
  yes: boolean;
  autoCreate: boolean;
  collate?: string;
  dryRun: boolean;
  compact: boolean;
  help: boolean;
}

const DEFAULTS: Pick<CliArgs, "mode" | "pageSize" | "batch" | "maxPages" | "yes" | "autoCreate" | "dryRun" | "compact" | "help"> = {
  mode: "truncate",
  pageSize: 1000,
  batch: 200,
  maxPages: 1000,
  yes: false,
  autoCreate: false,
  dryRun: false,
  compact: false,
  help: false,
};

const HELP = `data-sync — copy table data Source → mysql Dest (JSON to stdout)

Usage:
  npx tsx tools/data-sync.ts copy \\
    --src archery|mysql \\
    [--src-env <env> --src-instance "<name>"]   (required when --src=archery) \\
    [--src-conn <name>]                         (required when --src=mysql)  \\
    --src-db <db> \\
    --dst-conn <name> --dst-db <db> \\
    --tables t1,t2,t3 | src:dst,src:dst \\
    [options]

Source kinds:
  archery   read-only via Archery platform (Django session); for restricted envs
            where no direct DB access exists. Needs --src-env + --src-instance.
  mysql     direct mysql2 connection; faster. Needs --src-conn (named in
            .myws/db.config.json).

Options:
  --mode truncate|append   write mode (default: truncate)
  --pk <col>               explicit PK; default: auto-discover single-col PK
  --page-size N            cursor page size (default: 1000; archery caps server-side)
  --batch N                INSERT chunk size (default: 200)
  --max-pages N            safety cap on pages per table (default: 1000)
  --yes                    skip [y/N] confirm when dest has rows under truncate
  --auto-create            if dest table is missing, create it from source SHOW CREATE TABLE
  --collate <name|source>  (with --auto-create) inject COLLATE into DDL; default uses dest
                           DB default and aborts if source collation differs (keeps DB
                           consistent). --collate source = use source's TABLE_COLLATION.
  --dry-run                count both sides, plan only, no writes
  --compact                single-line JSON (default: pretty)
  -h, --help               show this help

Examples:
  # archery prd srcdb → local.destdb (3 tables, cursor pagination on PK)
  data-sync copy --src archery --src-env prd \\
    --src-instance "prod-mysql-ro-01" \\
    --src-db srcdb --dst-conn local --dst-db destdb \\
    --tables t1,t2,t3

  # mysql dev.srcdb.t1 → local.destdb.t1_copy (rename dst table)
  data-sync copy --src mysql --src-conn dev --src-db srcdb \\
    --dst-conn local --dst-db destdb --tables t1:t1_copy --mode append

  # peek first
  data-sync copy ... --dry-run

  # auto-create missing dest tables (DDL pulled from source SHOW CREATE TABLE)
  data-sync copy ... --auto-create --yes

Confirmation:
  Under --mode truncate, if dest already has rows AND --yes is not passed,
  the tool prompts [y/N] on stderr/stdin for EACH table. Non-interactive stdin
  (e.g. piped/agent runs) is refused — pass --yes to proceed.

Fail-fast:
  Any error (fetch / TRUNCATE / insert / schema mismatch) aborts the run and
  exits non-zero. TRUNCATE is irreversible; earlier tables stay synced.

Secrets come only from .myws/archery.config.json / .myws/db.config.json (gitignored).
`;

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { command: "", ...DEFAULTS };
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
      case "copy":
        a.command = "copy";
        break;
      case "--src":
        a.srcKind = next() as "archery" | "mysql";
        break;
      case "--src-env":
        a.srcEnv = next();
        break;
      case "--src-instance":
        a.srcInstance = next();
        break;
      case "--src-conn":
        a.srcConn = next();
        break;
      case "--src-db":
        a.srcDb = next();
        break;
      case "--dst-conn":
        a.dstConn = next();
        break;
      case "--dst-db":
        a.dstDb = next();
        break;
      case "--tables":
        a.tables = next();
        break;
      case "--mode":
        a.mode = next() as SyncMode;
        break;
      case "--pk":
        a.pk = next();
        break;
      case "--page-size":
        a.pageSize = Number.parseInt(next(), 10);
        break;
      case "--batch":
        a.batch = Number.parseInt(next(), 10);
        break;
      case "--max-pages":
        a.maxPages = Number.parseInt(next(), 10);
        break;
      case "--yes":
        a.yes = true;
        break;
      case "--auto-create":
        a.autoCreate = true;
        break;
      case "--collate":
        a.collate = next();
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--compact":
        a.compact = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return a;
}

function print(value: unknown, compact: boolean): void {
  process.stdout.write((compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + "\n");
}

function validate(args: CliArgs): void {
  const errs: string[] = [];
  if (args.command !== "copy") errs.push(`unknown/missing command (expected: copy)`);
  if (!args.srcKind) errs.push(`--src is required (archery|mysql)`);
  if (!args.srcDb) errs.push(`--src-db is required`);
  if (!args.dstConn) errs.push(`--dst-conn is required`);
  if (!args.dstDb) errs.push(`--dst-db is required`);
  if (!args.tables) errs.push(`--tables is required`);
  if (args.srcKind === "archery") {
    if (!args.srcEnv) errs.push(`--src-env is required when --src=archery`);
    if (!args.srcInstance) errs.push(`--src-instance is required when --src=archery`);
  } else if (args.srcKind === "mysql") {
    if (!args.srcConn) errs.push(`--src-conn is required when --src=mysql`);
  } else if (args.srcKind) {
    errs.push(`--src must be archery or mysql (got: ${args.srcKind})`);
  }
  if (args.mode !== "truncate" && args.mode !== "append") {
    errs.push(`--mode must be truncate|append (got: ${args.mode})`);
  }
  if (!Number.isFinite(args.pageSize) || args.pageSize <= 0) errs.push(`--page-size must be a positive integer`);
  if (!Number.isFinite(args.batch) || args.batch <= 0) errs.push(`--batch must be a positive integer`);
  if (!Number.isFinite(args.maxPages) || args.maxPages <= 0) errs.push(`--max-pages must be a positive integer`);
  if (errs.length > 0) {
    throw new Error(errs.join("; "));
  }
}

export async function run(argv: string[]): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(HELP);
    process.stderr.write(`\nerror: ${e instanceof Error ? e.message : e}\n`);
    process.exit(2);
  }
  if (args.help || args.command === "") {
    process.stdout.write(HELP);
    return;
  }
  try {
    validate(args);
  } catch (e) {
    process.stderr.write(HELP);
    process.stderr.write(`\nerror: ${e instanceof Error ? e.message : e}\n`);
    process.exit(2);
  }

  const specs = parseTableList(args.tables!);
  if (specs.length === 0) {
    process.stderr.write(`error: --tables parsed to zero specs\n`);
    process.exit(2);
  }

  const log = (msg: string): void => {
    process.stderr.write(msg + "\n");
  };

  let source;
  try {
    if (args.srcKind === "archery") {
      source = await openSource({
        kind: "archery",
        env: args.srcEnv!,
        instance: args.srcInstance!,
        db: args.srcDb!,
      });
    } else {
      source = await openSource({
        kind: "mysql",
        conn: args.srcConn!,
        db: args.srcDb!,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: failed to open source: ${msg}\n`);
    process.exit(1);
  }

  let dest;
  try {
    dest = await openDest({ conn: args.dstConn!, db: args.dstDb! });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await source.close().catch(() => undefined);
    process.stderr.write(`error: failed to open dest: ${msg}\n`);
    process.exit(1);
  }

  try {
    const summary = await syncTables(source, dest, specs, {
      mode: args.mode,
      pk: args.pk,
      pageSize: args.pageSize,
      batchSize: args.batch,
      maxPages: args.maxPages,
      yes: args.yes,
      autoCreate: args.autoCreate,
      collate: args.collate,
      dryRun: args.dryRun,
      log,
    });
    print(summary, args.compact);
    if (!summary.ok) process.exit(1);
  } finally {
    await source.close().catch(() => undefined);
    await dest.close().catch(() => undefined);
  }
}
