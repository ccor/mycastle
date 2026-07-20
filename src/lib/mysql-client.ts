// mysql-client.ts — thin mysql2/promise wrapper.
// Each call opens a short-lived connection (mirrors the Python original: no pool).
// Connection options make every row JSON-safe: dates → strings, BIGINT → string,
// BLOB → 0x-hex — so callers can JSON.stringify directly.

import { createConnection } from "mysql2/promise";
import type { DBConfig } from "./mysql-config.js";

export type Row = Record<string, unknown>;

/** Derived from createConnection's resolved value — avoids relying on a specific type export. */
type MysqlConnection = Awaited<ReturnType<typeof createConnection>>;

/** Convert non-JSON-safe cell values to plain JSON-safe forms. */
function normalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  return value;
}

const SYSTEM_DATABASES = new Set(["information_schema", "mysql", "performance_schema", "sys"]);

/**
 * Split a SQL script into individual statements on `;` terminators.
 * Respects single-quoted strings (`''` escape), backtick identifiers
 * (`` `` `` escape), `--`/`#` line comments, and `/* ... *​/` block comments.
 * Comment-only / whitespace-only segments are dropped. A trailing statement
 * without a final `;` is still returned.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  const n = sql.length;
  let buf = "";
  let i = 0;
  let quote: "'" | "`" | null = null;
  while (i < n) {
    const ch = sql[i] as string;
    const next = i + 1 < n ? (sql[i + 1] as string) : "";
    if (quote) {
      buf += ch;
      if (ch === quote) {
        if (next === quote) {
          buf += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }
    if ((ch === "-" && next === "-") || ch === "#") {
      while (i < n && sql[i] !== "\n") i += 1;
      if (i < n) {
        buf += "\n";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      buf += " ";
      continue;
    }
    if (ch === "'" || ch === "`") {
      quote = ch;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === ";") {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** Collapse whitespace and truncate a statement for preview output. */
export function previewStatement(sql: string, max = 200): string {
  const collapsed = sql.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** One statement's execution outcome (success or first-error fail-fast). */
export interface ExecResult {
  index: number;
  ok: boolean;
  sql: string;
  affectedRows: number;
  message: string;
  error?: string;
  elapsedMs: number;
}

export class MysqlHelper {
  readonly config: DBConfig;

  constructor(config: DBConfig) {
    this.config = config;
  }

  /** Open a connection (optionally overriding the database), run, always close. */
  private async withConnection<T>(
    fn: (conn: MysqlConnection) => Promise<T>,
    database?: string,
  ): Promise<T> {
    const db = database ?? this.config.database;
    const conn = await createConnection({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: db || undefined,
      charset: this.config.charset,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      return await fn(conn);
    } finally {
      await conn.end().catch(() => undefined);
    }
  }

  /** Run an arbitrary SELECT/SHOW/DESCRIBE; returns rows as plain objects. */
  async query(sql: string, database?: string): Promise<Row[]> {
    return this.withConnection(async (conn) => {
      const [rows] = await conn.query(sql);
      if (!Array.isArray(rows)) return [];
      return (rows as Row[]).map((r) => {
        const out: Row = {};
        for (const [k, v] of Object.entries(r)) out[k] = normalize(v);
        return out;
      });
    }, database);
  }

  /** User databases on the server (system DBs filtered out). */
  async showDatabases(): Promise<string[]> {
    const rows = await this.query("SHOW DATABASES");
    return rows
      .map((r) => String(Object.values(r)[0] ?? ""))
      .filter((d) => d.length > 0 && !SYSTEM_DATABASES.has(d));
  }

  /** Tables in a database. */
  async showTables(database?: string): Promise<string[]> {
    const rows = await this.query("SHOW TABLES", database);
    return rows.map((r) => String(Object.values(r)[0] ?? "")).filter((t) => t.length > 0);
  }

  /** Column definitions of a table (DESCRIBE). */
  async describeTable(table: string, database?: string): Promise<Row[]> {
    const id = "`" + String(table).replace(/`/g, "``") + "`";
    return this.query(`DESCRIBE ${id}`, database);
  }

  /**
   * Execute a list of statements sequentially on ONE connection, fail-fast.
   * On the first error, stops and returns results collected so far (the
   * failing one included with `ok:false`). Earlier DDL is already committed
   * (DDL auto-commits in MySQL); caller decides whether to roll back manually.
   */
  async executeStatements(statements: string[], database?: string): Promise<ExecResult[]> {
    return this.withConnection(async (conn) => {
      const results: ExecResult[] = [];
      for (let i = 0; i < statements.length; i++) {
        const sql = statements[i] as string;
        const start = Date.now();
        try {
          const [result] = await conn.query(sql);
          const r = result as { affectedRows?: number; message?: unknown };
          results.push({
            index: i,
            ok: true,
            sql: previewStatement(sql),
            affectedRows: typeof r.affectedRows === "number" ? r.affectedRows : 0,
            message: typeof r.message === "string" ? r.message : "",
            elapsedMs: Date.now() - start,
          });
        } catch (e) {
          results.push({
            index: i,
            ok: false,
            sql: previewStatement(sql),
            affectedRows: 0,
            message: "",
            error: e instanceof Error ? e.message : String(e),
            elapsedMs: Date.now() - start,
          });
          break;
        }
      }
      return results;
    }, database);
  }
}
