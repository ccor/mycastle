// mysql-helper.ts — read-only MySQL inspection CLI (JSON to stdout).
//
//   mycastle mysql <command> [args] [options]
//
// Commands:
//   show-databases                     list user databases (system DBs filtered out)
//   show-tables [database]             list tables in a database
//   describe <db.table | table>        show column definitions of a table
//
// Connection: DB_CONN_URL env var (highest priority) or .myws/db.config.json.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { resolveConnection } from "./lib/mysql-config.js";
import {
  MysqlHelper,
  splitSqlStatements,
  previewStatement,
  type Row,
} from "./lib/mysql-client.js";

interface CliArgs {
  rest: string[];
  db?: string;
  conn?: string;
  configPath?: string;
  dryRun: boolean;
  compact: boolean;
  help: boolean;
}

const HELP = `mysql-helper — MySQL inspection + DDL execution CLI (JSON to stdout)

Usage:
  mycastle mysql <command> [args] [options]

Commands:
  show-databases                     list user databases (system DBs filtered out)
  show-tables [database]             list tables in a database
  describe <db.table | table>        show column definitions of a table
  execute <file.sql>                 run a SQL script (DDL/migration); fail-fast per statement

Options:
  --db <name>        default database (overrides the one in the connection URL)
  --conn <name>      named connection from .myws/db.config.json (multi-connection form)
  --config <path>    override .myws/db.config.json
  --dry-run          (execute) parse + preview statements without executing
  --compact          single-line JSON (default: pretty)
  -h, --help         show this help

Connection (highest priority first):
  DB_CONN_URL env var — mysql://user:pass@host:3306/db?charset=utf8mb4
  .myws/db.config.json:
    { "url": "mysql://..." }                                            # single connection
    { "default": "primary", "connections": { "primary": { "url": "mysql://..." } } }

Table target: <database>.<table>, or bare <table> with --db <database>.
execute: statements run on ONE connection, sequentially, fail-fast (DDL auto-commits).
`;

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { rest: [], dryRun: false, compact: false, help: false };
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
      case "--db":
        a.db = next();
        break;
      case "--conn":
        a.conn = next();
        break;
      case "--config":
        a.configPath = next();
        break;
      case "--dry-run":
        a.dryRun = true;
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

/** Split "db.table" into (db, table); a bare "table" falls back to fallbackDb. */
function resolveTable(target: string, fallbackDb?: string): { db?: string; table: string } {
  const idx = target.indexOf(".");
  if (idx >= 0) {
    return { db: target.slice(0, idx), table: target.slice(idx + 1) };
  }
  return { db: fallbackDb, table: target };
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
  const known = new Set(["show-databases", "show-tables", "describe", "execute"]);
  if (!known.has(command)) {
    console.error(HELP);
    console.error(`error: unknown command: ${command}`);
    process.exit(2);
  }

  const resolved = resolveConnection({ connName: args.conn, configPath: args.configPath });
  const helper = new MysqlHelper(resolved.config);

  switch (command) {
    case "show-databases": {
      const databases = await helper.showDatabases();
      print({ connection: resolved.name, databases }, args.compact);
      break;
    }
    case "show-tables": {
      const db = cmdArgs[0] ?? args.db ?? resolved.config.database;
      if (!db) {
        console.error("error: show-tables needs a database (positional, --db, or the connection URL)");
        process.exit(2);
      }
      const tables = await helper.showTables(db);
      print({ connection: resolved.name, database: db, tables }, args.compact);
      break;
    }
    case "describe": {
      const target = cmdArgs[0];
      if (!target) {
        console.error("error: describe needs a table: <db.table> or <table> with --db");
        process.exit(2);
      }
      const { db, table } = resolveTable(target, args.db ?? resolved.config.database);
      if (!db) {
        console.error(`error: describe needs a database for "${table}" (use <db.table> or --db)`);
        process.exit(2);
      }
      const columns: Row[] = await helper.describeTable(table, db);
      print({ connection: resolved.name, database: db, table, columns }, args.compact);
      break;
    }
    case "execute": {
      const file = cmdArgs[0];
      if (!file) {
        console.error("error: execute needs a SQL file path");
        process.exit(2);
      }
      const filePath = path.resolve(process.cwd(), file);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch (e) {
        console.error(`error: cannot read ${filePath}: ${e instanceof Error ? e.message : e}`);
        process.exit(2);
      }
      const statements = splitSqlStatements(content);
      const db = args.db ?? resolved.config.database;
      if (args.dryRun) {
        print(
          {
            connection: resolved.name,
            database: db ?? null,
            file: filePath,
            dryRun: true,
            statementCount: statements.length,
            statements: statements.map((s, i) => ({ index: i, sql: previewStatement(s) })),
          },
          args.compact,
        );
        break;
      }
      if (!db) {
        console.error("error: execute needs a database (connection URL or --db) to run against");
        process.exit(2);
      }
      const results = await helper.executeStatements(statements, db);
      const failed = results.find((r) => !r.ok);
      print(
        {
          connection: resolved.name,
          database: db,
          file: filePath,
          statementCount: statements.length,
          executed: results.length,
          results,
        },
        args.compact,
      );
      if (failed) process.exit(1);
      break;
    }
    default:
      throw new Error(`unreachable: ${command}`);
  }
}
