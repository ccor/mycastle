// data-sync.ts — reusable orchestrator for copying table data Source → mysql Dest.
//
// Two source kinds:
//   - archery : read-only via Archery platform (Django session; for restricted envs
//               where you have no direct DB access)
//   - mysql   : direct mysql2 connection (faster; needs read grant on source)
// Destination is always mysql (one named connection from .myws/db.config.json).
//
// Cursor pagination over a single-column PK:
//   page 1   : SELECT * FROM `tbl`              ORDER BY `pk` LIMIT <page>
//   page n+1 : SELECT * FROM `tbl` WHERE `pk`>c ORDER BY `pk` LIMIT <page>
// until a page returns fewer than `page` rows.
//
// Fail-fast: any error during a table aborts the whole run. TRUNCATE is DDL
// (irreversible) — confirm before applying when dest already has rows.
//
// Collector-only contract: this module returns a structured result object;
// progress goes through the `log` callback (caller writes it to stderr).
//
// See tools/data-sync.md for the user-facing CLI.

import readline from "node:readline";

import { loadArcheryConfig } from "./archery-config.js";
import { ArcheryClient, type ArcheryQueryStep } from "./archery-client.js";
import { resolveConnection } from "./mysql-config.js";
import type { DBConfig } from "./mysql-config.js";
import { createConnection } from "mysql2/promise";

// --- common types ---

/** A row as a positional array of cells, aligned with `columns`. */
export type Row = unknown[];

export interface PageResult {
  columns: string[];
  rows: Row[];
  masked: boolean;
  /** Cursor value for the next page (last row's pk). `undefined` when done. */
  nextCursor: unknown;
}

export interface Source {
  readonly kind: "archery" | "mysql";
  readonly label: string;
  columns(table: string): Promise<string[]>;
  count(table: string): Promise<number>;
  /** Single-column PK name, or undefined if no clean PK exists. */
  discoverPk(table: string): Promise<string | undefined>;
  /** DDL text from `SHOW CREATE TABLE` (no trailing semicolon). */
  showCreateTable(table: string): Promise<string>;
  /** Table collation from information_schema (e.g. `utf8mb4_general_ci`); undefined if unknown. */
  tableCollation(table: string): Promise<string | undefined>;
  fetchPage(
    table: string,
    opts: { pk: string; cursor?: unknown; limit: number },
  ): Promise<PageResult>;
  close(): Promise<void>;
}

export interface Dest {
  readonly label: string;
  count(table: string): Promise<number>;
  columns(table: string): Promise<string[]>;
  truncate(table: string): Promise<void>;
  /** Insert rows; returns affected-row count. */
  insert(table: string, columns: string[], rows: Row[]): Promise<number>;
  /** Run a DDL statement (e.g. CREATE TABLE) on the dest. */
  applyDdl(ddl: string): Promise<void>;
  /** Default collation of the dest DATABASE (information_schema.SCHEMATA). */
  databaseCollation(): Promise<string | undefined>;
  close(): Promise<void>;
}

// --- sql helpers ---

/** Quote a MySQL identifier with backticks (doubled-escape inner backticks). */
export function quoteIdent(name: string): string {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

/** Render a JS value as a SQL literal (for text-SQL transports like archery). */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (Buffer.isBuffer(v)) return `X'${v.toString("hex")}'`;
  // string: escape backslashes then single quotes
  const s = String(v).replace(/\\/g, "\\\\").replace(/'/g, "''");
  return `'${s}'`;
}

/**
 * Inject `COLLATE=<collation>` after `DEFAULT CHARSET=...` when the DDL has no
 * explicit table-level COLLATE. Source DDL often omits COLLATE (relying on the
 * server default); applying it on a dest server with a different default (e.g.
 * MySQL 5.7 `utf8mb4_general_ci` vs MySQL 8 `utf8mb4_0900_ai_ci`) silently
 * changes uniqueness semantics and can break INSERTs with duplicate-key errors.
 *
 * If the DDL already contains `COLLATE` anywhere (table or column level), it is
 * left untouched.
 */
export function applyCollation(ddl: string, collation: string): string {
  if (/\bCOLLATE\b/i.test(ddl)) return ddl;
  // Match `DEFAULT CHARSET=name` or `DEFAULT CHARACTER SET name` (with optional `=`).
  const re = /(DEFAULT\s+(?:CHARSET|CHARACTER\s+SET)\s*=?\s*\w+)/i;
  if (!re.test(ddl)) return ddl;
  return ddl.replace(re, `$1 COLLATE=${collation}`);
}

// --- archery source ---

export interface ArcherySourceOpts {
  env: string;
  instance: string;
  db: string;
  configPath?: string;
}

class ArcherySource implements Source {
  readonly kind = "archery" as const;
  readonly label: string;
  private readonly client: ArcheryClient;
  private readonly instance: string;
  private readonly db: string;

  constructor(opts: ArcherySourceOpts) {
    const cfg = loadArcheryConfig({ configPath: opts.configPath });
    const env = cfg.envs[opts.env];
    if (!env) {
      const known = Object.keys(cfg.envs).join(", ");
      throw new Error(`archery env "${opts.env}" not in config; known: ${known}`);
    }
    this.client = new ArcheryClient({
      env: opts.env,
      baseUrl: env.url,
      username: env.username,
      password: env.password,
    });
    this.instance = opts.instance;
    this.db = opts.db;
    this.label = `archery:${opts.env}/${opts.db}`;
  }

  async columns(table: string): Promise<string[]> {
    const sql =
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS ` +
      `WHERE TABLE_SCHEMA='${this.db.replace(/'/g, "''")}' ` +
      `AND TABLE_NAME='${table.replace(/'/g, "''")}' ` +
      `ORDER BY ORDINAL_POSITION`;
    const rows = await this.runMeta(sql, 5000);
    return rows.map((r) => String(r[0] ?? ""));
  }

  async count(table: string): Promise<number> {
    const rows = await this.runMeta(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`, 1);
    return Number(rows[0]?.[0] ?? 0);
  }

  async discoverPk(table: string): Promise<string | undefined> {
    const sql =
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE ` +
      `WHERE TABLE_SCHEMA='${this.db.replace(/'/g, "''")}' ` +
      `AND TABLE_NAME='${table.replace(/'/g, "''")}' ` +
      `AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION`;
    const rows = await this.runMeta(sql, 10);
    if (rows.length !== 1) return undefined;
    return String(rows[0]?.[0] ?? "");
  }

  async fetchPage(
    table: string,
    opts: { pk: string; cursor?: unknown; limit: number },
  ): Promise<PageResult> {
    const where =
      opts.cursor !== undefined && opts.cursor !== null
        ? ` WHERE ${quoteIdent(opts.pk)} > ${sqlLiteral(opts.cursor)}`
        : "";
    const sql =
      `SELECT * FROM ${quoteIdent(table)}${where} ` +
      `ORDER BY ${quoteIdent(opts.pk)} LIMIT ${Math.max(1, Math.floor(opts.limit))}`;
    const steps: ArcheryQueryStep[] = await this.client.query.run({
      instance: this.instance,
      db: this.db,
      sql,
      limit: opts.limit,
    });
    const step = steps[0];
    if (!step || step.status !== 0) {
      throw new Error(
        `archery query failed: ${step?.msg ?? step?.data?.error ?? "no step"} | sql: ${sql}`,
      );
    }
    const columns = step.data.column_list ?? [];
    const rows = (step.data.rows ?? []) as Row[];
    const masked = !!step.data.is_masked;
    const pkIdx = columns.indexOf(opts.pk);
    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length < opts.limit || !last || pkIdx < 0 ? undefined : last[pkIdx];
    return { columns, rows, masked, nextCursor };
  }

  async showCreateTable(table: string): Promise<string> {
    const rows = await this.runMeta(`SHOW CREATE TABLE ${quoteIdent(table)}`, 1);
    // SHOW CREATE TABLE returns [Table, "Create Table"]
    const row = rows[0];
    if (!row || row.length < 2) {
      throw new Error(`archery SHOW CREATE TABLE returned no DDL for ${table}`);
    }
    return String(row[1] ?? "");
  }

  async tableCollation(table: string): Promise<string | undefined> {
    const sql =
      `SELECT TABLE_COLLATION FROM information_schema.TABLES ` +
      `WHERE TABLE_SCHEMA='${this.db.replace(/'/g, "''")}' ` +
      `AND TABLE_NAME='${table.replace(/'/g, "''")}'`;
    const rows = await this.runMeta(sql, 1);
    const v = rows[0]?.[0];
    return v === null || v === undefined ? undefined : String(v);
  }

  close(): Promise<void> {
    // ArcheryClient has no persistent resource; session persists on disk.
    return Promise.resolve();
  }

  private async runMeta(sql: string, limit: number): Promise<Row[]> {
    const steps: ArcheryQueryStep[] = await this.client.query.run({
      instance: this.instance,
      db: this.db,
      sql,
      limit,
    });
    const step = steps[0];
    if (!step || step.status !== 0) {
      throw new Error(
        `archery meta query failed: ${step?.msg ?? "no step"} | sql: ${sql}`,
      );
    }
    return (step.data.rows ?? []) as Row[];
  }
}

// --- mysql source ---

export interface MysqlSourceOpts {
  conn: string;
  db: string;
  configPath?: string;
}

class MysqlSource implements Source {
  readonly kind = "mysql" as const;
  readonly label: string;
  private readonly connName: string;
  private readonly db: string;
  private readonly dbConfig: DBConfig;
  private conn: Awaited<ReturnType<typeof createConnection>> | undefined;
  private readonly colCache = new Map<string, string[]>();

  private constructor(opts: MysqlSourceOpts, connName: string, dbConfig: DBConfig) {
    this.connName = connName;
    this.db = opts.db;
    this.dbConfig = dbConfig;
    this.label = `mysql:${connName}/${opts.db}`;
  }

  static async create(opts: MysqlSourceOpts): Promise<MysqlSource> {
    const { config, name } = resolveConnection({ connName: opts.conn, configPath: opts.configPath });
    const s = new MysqlSource(opts, name, config);
    s.conn = await createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: opts.db,
      charset: config.charset,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    });
    return s;
  }

  private async ensure(): Promise<NonNullable<MysqlSource["conn"]>> {
    if (!this.conn) throw new Error("mysql source not opened");
    return this.conn;
  }

  async columns(table: string): Promise<string[]> {
    const cached = this.colCache.get(table);
    if (cached) return cached;
    const c = await this.ensure();
    const [rows] = await c.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [this.db, table],
    );
    const cols = (rows as Array<{ c: string }>).map((r) => String(r.c));
    this.colCache.set(table, cols);
    return cols;
  }

  async count(table: string): Promise<number> {
    const c = await this.ensure();
    const [rows] = await c.query(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`);
    return Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
  }

  async discoverPk(table: string): Promise<string | undefined> {
    const c = await this.ensure();
    const [rows] = await c.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE " +
        "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' " +
        "ORDER BY ORDINAL_POSITION",
      [this.db, table],
    );
    const arr = rows as Array<{ c: string }>;
    if (arr.length !== 1) return undefined;
    return String(arr[0]?.c ?? "");
  }

  async fetchPage(
    table: string,
    opts: { pk: string; cursor?: unknown; limit: number },
  ): Promise<PageResult> {
    const c = await this.ensure();
    const cols = await this.columns(table);
    const limit = Math.max(1, Math.floor(opts.limit));
    const sql =
      opts.cursor !== undefined && opts.cursor !== null
        ? `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(opts.pk)} > ? ORDER BY ${quoteIdent(opts.pk)} LIMIT ?`
        : `SELECT * FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(opts.pk)} LIMIT ?`;
    const params =
      opts.cursor !== undefined && opts.cursor !== null ? [opts.cursor, limit] : [limit];
    const [result] = await c.query(sql, params);
    const rowsObj = result as Record<string, unknown>[];
    const rows: Row[] = rowsObj.map((r) => cols.map((col) => r[col]));
    const pkIdx = cols.indexOf(opts.pk);
    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length < limit || !last || pkIdx < 0 ? undefined : last[pkIdx];
    return { columns: cols, rows, masked: false, nextCursor };
  }

  async showCreateTable(table: string): Promise<string> {
    const c = await this.ensure();
    const [rows] = await c.query(`SHOW CREATE TABLE ${quoteIdent(table)}`);
    const arr = rows as Array<{ Table: string; "Create Table": string }>;
    const row = arr[0];
    if (!row) throw new Error(`mysql SHOW CREATE TABLE returned no row for ${table}`);
    return String(row["Create Table"] ?? "");
  }

  async tableCollation(table: string): Promise<string | undefined> {
    const c = await this.ensure();
    const [rows] = await c.query(
      "SELECT TABLE_COLLATION AS col FROM information_schema.TABLES " +
        "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [this.db, table],
    );
    const v = (rows as Array<{ col: string | null }>)[0]?.col;
    return v === null || v === undefined ? undefined : v;
  }

  async close(): Promise<void> {
    if (this.conn) await this.conn.end().catch(() => undefined);
  }
}

// --- mysql dest ---

export interface MysqlDestOpts {
  conn: string;
  db: string;
  configPath?: string;
}

class MysqlDest implements Dest {
  readonly label: string;
  private readonly connName: string;
  private readonly db: string;
  private conn: Awaited<ReturnType<typeof createConnection>> | undefined;

  private constructor(opts: MysqlDestOpts, connName: string) {
    this.connName = connName;
    this.db = opts.db;
    this.label = `mysql:${connName}/${opts.db}`;
  }

  static async create(opts: MysqlDestOpts): Promise<MysqlDest> {
    const { config, name } = resolveConnection({ connName: opts.conn, configPath: opts.configPath });
    const d = new MysqlDest(opts, name);
    d.conn = await createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: opts.db,
      charset: config.charset,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    });
    return d;
  }

  private async ensure(): Promise<NonNullable<MysqlDest["conn"]>> {
    if (!this.conn) throw new Error("mysql dest not opened");
    return this.conn;
  }

  async count(table: string): Promise<number> {
    const c = await this.ensure();
    const [rows] = await c.query(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`);
    return Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
  }

  async columns(table: string): Promise<string[]> {
    const c = await this.ensure();
    const [rows] = await c.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [this.db, table],
    );
    return (rows as Array<{ c: string }>).map((r) => String(r.c));
  }

  async truncate(table: string): Promise<void> {
    const c = await this.ensure();
    await c.query(`TRUNCATE TABLE ${quoteIdent(table)}`);
  }

  async insert(table: string, columns: string[], rows: Row[]): Promise<number> {
    if (rows.length === 0) return 0;
    const c = await this.ensure();
    const colSql = columns.map((x) => quoteIdent(x)).join(", ");
    // mysql2 bulk insert: single ? expands to (v,..),(v,..),...
    const sql = `INSERT INTO ${quoteIdent(table)} (${colSql}) VALUES ?`;
    const [res] = await c.query(sql, [rows]);
    const r = res as { affectedRows?: number };
    return typeof r.affectedRows === "number" ? r.affectedRows : 0;
  }

  async applyDdl(ddl: string): Promise<void> {
    const c = await this.ensure();
    await c.query(ddl);
  }

  async databaseCollation(): Promise<string | undefined> {
    const c = await this.ensure();
    const [rows] = await c.query(
      "SELECT DEFAULT_COLLATION_NAME AS col FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      [this.db],
    );
    const v = (rows as Array<{ col: string | null }>)[0]?.col;
    return v === null || v === undefined ? undefined : v;
  }

  async close(): Promise<void> {
    if (this.conn) await this.conn.end().catch(() => undefined);
  }
}

// --- factories ---

export type SourceOpts =
  | ({ kind: "archery" } & ArcherySourceOpts)
  | ({ kind: "mysql" } & MysqlSourceOpts);

export async function openSource(opts: SourceOpts): Promise<Source> {
  if (opts.kind === "archery") return new ArcherySource(opts);
  return await MysqlSource.create(opts);
}

export async function openDest(opts: MysqlDestOpts): Promise<Dest> {
  return await MysqlDest.create(opts);
}

// --- table spec parsing ---

export interface TableSpec {
  srcTable: string;
  dstTable: string;
}

/** Parse "t1,t2,t3" or "src:dst,src:dst" into specs. */
export function parseTableList(input: string): TableSpec[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const i = s.indexOf(":");
      if (i < 0) return { srcTable: s, dstTable: s };
      return { srcTable: s.slice(0, i).trim(), dstTable: s.slice(i + 1).trim() };
    });
}

// --- confirm prompt ---

export type ConfirmFn = (ctx: { dstTable: string; dstRows: number }) => Promise<boolean>;

/** Interactive y/N prompt; refuses when stdin is not a TTY. */
export async function interactiveConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write(`${question} (non-interactive stdin — pass --yes to proceed)\n`);
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

// --- orchestrator ---

export type SyncMode = "truncate" | "append";

export interface SyncOptions {
  mode: SyncMode;
  /** Explicit PK column; if undefined, auto-discover single-column PK. */
  pk?: string;
  pageSize: number;
  batchSize: number;
  maxPages: number;
  /** Skip confirm prompt for non-empty dest under truncate mode. */
  yes: boolean;
  /** If dest table is missing, create it from `SHOW CREATE TABLE` on source. */
  autoCreate: boolean;
  /**
   * Collation injection policy for --auto-create:
   *   undefined / "" / "dest" → use dest DB default (abort if source differs)
   *   "source"                → inject source's TABLE_COLLATION
   *   "<name>"                → inject this explicit collation
   */
  collate?: string;
  /** Count both sides only; perform no writes. */
  dryRun: boolean;
  /** Override the truncate-confirm gate (used by CLI / tests). */
  confirm?: ConfirmFn;
  /** Progress sink (stderr in the CLI). */
  log?: (msg: string) => void;
}

export interface SyncTableResult {
  srcTable: string;
  dstTable: string;
  pk: string | null;
  pages: number;
  srcRows: number;
  dstRowsBefore: number;
  dstRowsAfter: number;
  masked: boolean;
  mode: SyncMode;
  dryRun: boolean;
  skipped: boolean;
  reason?: string;
  insertedRows: number;
  autoCreated: boolean;
  elapsedMs: number;
}

const DEFAULT_CONFIRM: ConfirmFn = async ({ dstTable, dstRows }) => {
  const q = `TRUNCATE will erase ${dstRows} row(s) in ${dstTable}. Proceed? [y/N] `;
  return await interactiveConfirm(q);
};

function diffColumns(src: string[], dst: string[]): { missing: string[]; extra: string[] } {
  const dstSet = new Set(dst);
  const srcSet = new Set(src);
  return {
    missing: src.filter((c) => !dstSet.has(c)),
    extra: dst.filter((c) => !srcSet.has(c)),
  };
}

/**
 * Copy one table from source to dest. Fail-fast: throws on any error.
 * Under truncate mode, refuses to TRUNCATE non-empty dest unless the
 * confirm gate returns true (or `yes: true` is passed).
 */
export async function syncTable(
  source: Source,
  dest: Dest,
  spec: TableSpec,
  opts: SyncOptions,
): Promise<SyncTableResult> {
  const log = opts.log ?? (() => undefined);
  const confirm = opts.confirm ?? DEFAULT_CONFIRM;
  const start = Date.now();
  const { srcTable, dstTable } = spec;

  log(`[${srcTable} → ${dstTable}] discovering schema...`);
  const srcCols = await source.columns(srcTable);
  let dstCols = await dest.columns(dstTable);
  let autoCreated = false;

  // Auto-create dest table if missing entirely (0 columns from information_schema).
  if (dstCols.length === 0) {
    if (!opts.autoCreate) {
      throw new Error(
        `dest ${dstTable} does not exist (or has 0 columns). ` +
          `Pass --auto-create to create it from the source's SHOW CREATE TABLE.`,
      );
    }
    log(`[${srcTable}] dst ${dstTable} missing; auto-creating via SHOW CREATE TABLE...`);
    let ddl = await source.showCreateTable(srcTable);

    // Collation policy (opt-in):
    //   --collate source        → inject source's TABLE_COLLATION
    //   --collate <name>        → inject this explicit collation
    //   (no flag, default)      → use dest DB default; if source's TABLE_COLLATION
    //                              differs from dest DB default, ABORT with an
    //                              actionable message (don't silently split the
    //                              dest DB into mixed collations).
    // Rationale: silently injecting source collation per-table makes the dest DB
    // accumulate mixed collations, which breaks cross-table JOINs ("Illegal mix
    // of collations"). Collation is a DATABASE-level decision, not per-table.
    if (!/\bCOLLATE\b/i.test(ddl)) {
      const srcCollation = await source.tableCollation(srcTable);
      let injectCollation: string | undefined;
      if (opts.collate === "source") {
        injectCollation = srcCollation;
      } else if (opts.collate && opts.collate !== "dest") {
        injectCollation = opts.collate;
      } else if (!opts.collate) {
        const dstDbCollation = await dest.databaseCollation();
        if (srcCollation && dstDbCollation && srcCollation !== dstDbCollation) {
          throw new Error(
            `collation mismatch for new dest table ${dstTable}:\n` +
              `  source table collation : ${srcCollation}\n` +
              `  dest DB default        : ${dstDbCollation}\n` +
              `Inheriting the dest DB default would widen accent/case equivalence ` +
              `and can break unique keys (Duplicate entry) when copying source data. ` +
              `Pick ONE strategy and re-run:\n` +
              `  1. Unify the dest DB  : ALTER DATABASE <dst_db> COLLATE ${srcCollation} ` +
              `(then no flag needed; keeps the DB consistent)\n` +
              `  2. This table only    : --collate source  (injects ${srcCollation} into DDL)\n` +
              `  3. Force dest default : --collate ${dstDbCollation}  (may still fail on dup-key)`,
          );
        }
      }
      if (injectCollation) {
        ddl = applyCollation(ddl, injectCollation);
        log(`[${srcTable}] injected COLLATE=${injectCollation} into DDL`);
      }
    }

    if (dstTable !== srcTable) {
      // Rewrite the table name in `CREATE TABLE \`src\` (...)` to the dst name.
      // Only the FIRST occurrence (the header) is rewritten — column defs /
      // constraints referencing the src name (rare: self-FK, CHECK) are left
      // alone. We avoid CREATE+RENAME because the src name may already exist
      // on the dst DB (e.g. copying srcdb.foo → destdb.foo when destdb.foo exists).
      const srcQ = "`" + srcTable + "`";
      const dstQ = "`" + dstTable + "`";
      const idx = ddl.indexOf(srcQ);
      if (idx < 0) {
        throw new Error(
          `cannot rewrite table name in DDL: backtick-quoted \`${srcTable}\` not found in SHOW CREATE TABLE output`,
        );
      }
      ddl = ddl.slice(0, idx) + dstQ + ddl.slice(idx + srcQ.length);
      log(`[${srcTable}] rewrote CREATE TABLE name → ${dstTable}`);
    }
    try {
      await dest.applyDdl(ddl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`auto-CREATE failed for ${dstTable}: ${msg} | ddl head: ${ddl.slice(0, 200)}`);
    }
    dstCols = await dest.columns(dstTable);
    autoCreated = true;
    if (dstCols.length === 0) {
      throw new Error(`auto-create applied but ${dstTable} still reports 0 columns`);
    }
    log(`[${srcTable}] created ${dstTable} with ${dstCols.length} columns`);
  }

  const diff = diffColumns(srcCols, dstCols);
  if (diff.missing.length > 0) {
    throw new Error(
      `dest ${dstTable} is missing ${diff.missing.length} column(s) present in source: ` +
        `${diff.missing.join(", ")} (src has ${srcCols.length} cols, dst has ${dstCols.length})`,
    );
  }
  if (diff.extra.length > 0) {
    log(`[${srcTable}] note: dest has ${diff.extra.length} extra column(s): ${diff.extra.join(", ")} (they will get SQL NULL/default)`);
  }

  // Determine PK column.
  let pk = opts.pk ?? (await source.discoverPk(srcTable)) ?? undefined;
  if (!pk) {
    throw new Error(
      `could not auto-discover single-column PK for ${srcTable}; pass --pk <col>`,
    );
  }
  if (!srcCols.includes(pk)) {
    throw new Error(`pk column "${pk}" not present in ${srcTable} columns`);
  }

  const dstRowsBefore = await dest.count(dstTable);
  const srcCount = await source.count(srcTable);
  log(`[${srcTable}] src rows ≈ ${srcCount}; dst rows before = ${dstRowsBefore}; pk = ${pk}`);

  if (opts.dryRun) {
    return {
      srcTable,
      dstTable,
      pk,
      pages: 0,
      srcRows: srcCount,
      dstRowsBefore,
      dstRowsAfter: dstRowsBefore,
      masked: false,
      mode: opts.mode,
      dryRun: true,
      skipped: true,
      reason: "dry-run",
      insertedRows: 0,
      autoCreated,
      elapsedMs: Date.now() - start,
    };
  }

  // Confirm before destructive TRUNCATE.
  if (opts.mode === "truncate" && dstRowsBefore > 0 && !opts.yes) {
    const ok = await confirm({ dstTable, dstRows: dstRowsBefore });
    if (!ok) {
      log(`[${srcTable}] skipped (user declined TRUNCATE)`);
      return {
        srcTable,
        dstTable,
        pk,
        pages: 0,
        srcRows: srcCount,
        dstRowsBefore,
        dstRowsAfter: dstRowsBefore,
        masked: false,
        mode: opts.mode,
        dryRun: false,
        skipped: true,
        reason: "declined-truncate",
        insertedRows: 0,
        autoCreated,
        elapsedMs: Date.now() - start,
      };
    }
  }

  if (opts.mode === "truncate") {
    log(`[${srcTable}] TRUNCATE ${dstTable}...`);
    try {
      await dest.truncate(dstTable);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`TRUNCATE ${dstTable} failed: ${msg}`);
    }
  }

  // Fetch + insert with cursor pagination.
  let cursor: unknown = undefined;
  let pages = 0;
  let inserted = 0;
  let masked = false;
  while (pages < opts.maxPages) {
    pages += 1;
    const page = await source.fetchPage(srcTable, { pk, cursor, limit: opts.pageSize });
    if (page.masked) masked = true;
    if (page.rows.length > 0) {
      // Insert in chunks of batchSize. Use only the columns that exist in dest
      // (in src column order) so `VALUES ?` aligns with the column list.
      const insertCols = srcCols.filter((c) => dstCols.includes(c));
      const idx = srcCols.map((_, i) => i).filter((i) => dstCols.includes(srcCols[i]!));
      for (let i = 0; i < page.rows.length; i += opts.batchSize) {
        const chunk = page.rows.slice(i, i + opts.batchSize);
        const mapped = chunk.map((r) => idx.map((j) => r[j]));
        const affected = await dest.insert(dstTable, insertCols, mapped);
        inserted += affected;
      }
      log(`[${srcTable}] page ${pages}: +${page.rows.length} rows (total inserted ${inserted})`);
    } else {
      log(`[${srcTable}] page ${pages}: empty — done`);
    }
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  if (pages >= opts.maxPages) {
    log(`[${srcTable}] WARNING: hit --max-pages ${opts.maxPages} cap; data may be incomplete`);
  }

  const dstRowsAfter = await dest.count(dstTable);
  if (dstRowsAfter !== dstRowsBefore - (opts.mode === "truncate" ? dstRowsBefore : 0) + inserted) {
    log(`[${srcTable}] note: dst count after = ${dstRowsAfter}, inserted = ${inserted}`);
  }
  if (inserted !== srcCount && srcCount > 0) {
    log(`[${srcTable}] WARNING: inserted ${inserted} vs src count ${srcCount} (count may be approximate)`);
  }

  return {
    srcTable,
    dstTable,
    pk,
    pages,
    srcRows: srcCount,
    dstRowsBefore,
    dstRowsAfter,
    masked,
    mode: opts.mode,
    dryRun: false,
    skipped: false,
    insertedRows: inserted,
    autoCreated,
    elapsedMs: Date.now() - start,
  };
}

export interface SyncSummary {
  ok: boolean;
  src: { kind: "archery" | "mysql"; label: string };
  dst: { label: string };
  mode: SyncMode;
  dryRun: boolean;
  tables: SyncTableResult[];
  failedTable?: string;
  error?: string;
  elapsedMs: number;
}

/**
 * Sync multiple tables. Fail-fast: first error aborts the run, partially-synced
 * earlier tables stay (TRUNCATE is irreversible). The returned summary always
 * reflects what completed before any failure.
 */
export async function syncTables(
  source: Source,
  dest: Dest,
  specs: TableSpec[],
  opts: SyncOptions,
): Promise<SyncSummary> {
  const start = Date.now();
  const results: SyncTableResult[] = [];
  try {
    for (const spec of specs) {
      const r = await syncTable(source, dest, spec, opts);
      results.push(r);
    }
    return {
      ok: true,
      src: { kind: source.kind, label: source.label },
      dst: { label: dest.label },
      mode: opts.mode,
      dryRun: opts.dryRun,
      tables: results,
      elapsedMs: Date.now() - start,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      src: { kind: source.kind, label: source.label },
      dst: { label: dest.label },
      mode: opts.mode,
      dryRun: opts.dryRun,
      tables: results,
      failedTable: results.length < specs.length ? specs[results.length]!.srcTable : undefined,
      error: msg,
      elapsedMs: Date.now() - start,
    };
  }
}
