// table-sync.ts — compare table data between two archery environments (prd → other)
// and generate sync SQL for MANUAL execution. Both sides are read-only via Archery;
// the generated file is executed by you (e.g. `mycastle mysql execute`).
//
//   mycastle table-sync diff \
//     --src-instance "<name>" --dst-instance "<name>" --db <db> --tables t1,t2 \
//     [--src-env prd] [--dst-env test] [--pk <col>] [--filter '<where>']
//
//   mycastle table-sync gen-sql \
//     --src-instance "<name>" --dst-instance "<name>" --db <db> --tables t1,t2 \
//     --out <file.sql> [--mode full|missing] [--filter '<where>'] [--pk <col>]
//
// Commands:
//   diff     按单列主键对比两环境表数据 → JSON 报告(源独有/目标独有/值有差异)
//   gen-sql  生成同步 SQL 文件:
//              --mode full    先 DELETE 清空目标表再 INSERT 源全量(使两环境完全一致)
//              --mode missing 只 INSERT 源存在而目标缺失(按主键)的行(保留目标独有行)
//            --filter 作为 WHERE 片段同时作用于源/目标两侧
//
// Secrets come only from .myws/archery.config.json (gitignored).

import process from "node:process";
import fs from "node:fs";

import { loadArcheryConfig, type ArcheryConfig } from "./lib/archery-config.js";
import { ArcheryClient } from "./lib/archery-client.js";
import { quoteIdent, sqlLiteral } from "./lib/data-sync.js";

// --- small archery query helpers (read-only) ---

interface Ctx {
  env: string;
  instance: string;
  db: string;
  client: ArcheryClient;
}

function openCtx(env: string, instance: string, db: string, cfg: ArcheryConfig): Ctx {
  const envCfg = cfg.envs[env];
  if (!envCfg) {
    const known = Object.keys(cfg.envs).join(", ");
    throw new Error(`archery env "${env}" not in config; known: ${known}`);
  }
  return {
    env,
    instance,
    db,
    client: new ArcheryClient({
      env,
      baseUrl: envCfg.url,
      username: envCfg.username,
      password: envCfg.password,
    }),
  };
}

async function runQuery(
  ctx: Ctx,
  sql: string,
  limit: number,
): Promise<{ rows: unknown[][]; cols: string[]; masked: boolean }> {
  const steps = await ctx.client.query.run({ instance: ctx.instance, db: ctx.db, sql, limit });
  const step = steps[0];
  if (!step || step.status !== 0) {
    throw new Error(`archery query failed: ${step?.msg ?? step?.data?.error ?? "no step"} | sql: ${sql}`);
  }
  return {
    rows: step.data.rows ?? [],
    cols: step.data.column_list ?? [],
    masked: !!step.data.is_masked,
  };
}

async function columns(ctx: Ctx, table: string): Promise<string[]> {
  const sql =
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS ` +
    `WHERE TABLE_SCHEMA='${ctx.db.replace(/'/g, "''")}' AND TABLE_NAME='${table.replace(/'/g, "''")}' ` +
    `ORDER BY ORDINAL_POSITION`;
  const { rows } = await runQuery(ctx, sql, 5000);
  return rows.map((r) => String(r[0] ?? ""));
}

async function countRows(ctx: Ctx, table: string, filter?: string): Promise<number> {
  const where = filter ? ` WHERE ${filter}` : "";
  const { rows } = await runQuery(ctx, `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}${where}`, 1);
  return Number(rows[0]?.[0] ?? 0);
}

async function discoverPk(ctx: Ctx, table: string): Promise<string | undefined> {
  const sql =
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE ` +
    `WHERE TABLE_SCHEMA='${ctx.db.replace(/'/g, "''")}' AND TABLE_NAME='${table.replace(/'/g, "''")}' ` +
    `AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION`;
  const { rows } = await runQuery(ctx, sql, 10);
  if (rows.length !== 1) return undefined;
  return String(rows[0]?.[0] ?? "");
}

/** Fetch ALL rows (cursor-paginated over pk), optionally narrowed by a WHERE fragment. */
async function fetchAll(
  ctx: Ctx,
  table: string,
  pk: string,
  opts: { filter?: string; pageSize: number },
): Promise<{ rows: unknown[][]; cols: string[]; masked: boolean; pages: number }> {
  const cols = await columns(ctx, table);
  const pkIdx = cols.indexOf(pk);
  if (pkIdx < 0) throw new Error(`pk column "${pk}" not in ${ctx.env}.${table} columns`);
  const all: unknown[][] = [];
  let cursor: unknown = undefined;
  let masked = false;
  let pages = 0;
  for (;;) {
    pages += 1;
    const filter = opts.filter ?? "";
    const whereParts: string[] = [];
    if (filter) whereParts.push(`(${filter})`);
    if (cursor !== undefined && cursor !== null) whereParts.push(`${quoteIdent(pk)} > ${sqlLiteral(cursor)}`);
    const where = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const sql =
      `SELECT * FROM ${quoteIdent(table)}${where} ORDER BY ${quoteIdent(pk)} LIMIT ${opts.pageSize}`;
    const { rows, cols: c, masked: m } = await runQuery(ctx, sql, opts.pageSize);
    if (m) masked = true;
    if (c.length > 0 && (cols.length !== c.length || cols.some((x, i) => c[i] !== x))) {
      throw new Error(`column list changed mid-pagination for ${ctx.env}.${table}`);
    }
    if (rows.length === 0) break;
    all.push(...rows);
    const last = rows[rows.length - 1];
    if (rows.length < opts.pageSize || last === undefined) break;
    cursor = last[pkIdx];
  }
  return { rows: all, cols, masked, pages };
}

// --- shared value helpers ---

function norm(v: unknown): string {
  if (v === null || v === undefined) return "\u0000NULL";
  if (typeof v === "string" && v.trim() === "") return "\u0000EMPTY";
  return String(v);
}

function rowToObj(row: unknown[], cols: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  cols.forEach((c, i) => {
    o[c] = row[i] ?? null;
  });
  return o;
}

const DEFAULT_PAGE_SIZE = 2000;

// --- diff command ---

export async function diffTables(
  src: Ctx,
  dst: Ctx,
  tables: string[],
  opts: { pk?: string; filter?: string; pageSize?: number; log?: (m: string) => void },
): Promise<unknown> {
  const log = opts.log ?? (() => undefined);
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const report: {
    src: { env: string; instance: string; db: string };
    dst: { env: string; instance: string; db: string };
    filter: string | null;
    tables: Record<string, unknown>;
  } = {
    src: { env: src.env, instance: src.instance, db: src.db },
    dst: { env: dst.env, instance: dst.instance, db: dst.db },
    filter: opts.filter ?? null,
    tables: {},
  };
  for (const table of tables) {
    log(`[diff] ${table}: fetching ${src.env}...`);
    const s = await fetchAll(src, table, opts.pk ?? (await mustPk(src, table, opts.pk)), { filter: opts.filter, pageSize });
    log(`[diff] ${table}: fetching ${dst.env}...`);
    const pk = opts.pk ?? (await mustPk(dst, table, opts.pk));
    const d = await fetchAll(dst, table, pk, { filter: opts.filter, pageSize });

    const sMap = new Map<string, Record<string, unknown>>();
    const dMap = new Map<string, Record<string, unknown>>();
    for (const r of s.rows) sMap.set(String(r[s.cols.indexOf(pk)]), rowToObj(r, s.cols));
    for (const r of d.rows) dMap.set(String(r[d.cols.indexOf(pk)]), rowToObj(r, d.cols));

    const commonCols = s.cols.filter((c) => d.cols.includes(c));
    const srcOnly: string[] = [];
    const dstOnly: string[] = [];
    const valueDiff: { id: string; fields: string[] }[] = [];
    for (const id of sMap.keys()) {
      if (!dMap.has(id)) {
        srcOnly.push(id);
        continue;
      }
      const a = sMap.get(id)!;
      const b = dMap.get(id)!;
      const fields = commonCols.filter((c) => norm(a[c]) !== norm(b[c]));
      if (fields.length > 0) valueDiff.push({ id, fields });
    }
    for (const id of dMap.keys()) if (!sMap.has(id)) dstOnly.push(id);

    report.tables[table] = {
      pk,
      srcRows: s.rows.length,
      dstRows: d.rows.length,
      masked: s.masked || d.masked,
      columns: {
        srcOnly: s.cols.filter((c) => !d.cols.includes(c)),
        dstOnly: d.cols.filter((c) => !s.cols.includes(c)),
      },
      srcOnly: { count: srcOnly.length, ids: srcOnly },
      dstOnly: { count: dstOnly.length, ids: dstOnly },
      valueDiff: { count: valueDiff.length, rows: valueDiff },
    };
    log(
      `[diff] ${table}: src=${s.rows.length} dst=${d.rows.length} ` +
        `srcOnly=${srcOnly.length} dstOnly=${dstOnly.length} valueDiff=${valueDiff.length}`,
    );
  }
  return report;
}

async function mustPk(ctx: Ctx, table: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const pk = await discoverPk(ctx, table);
  if (!pk) throw new Error(`cannot auto-discover single-column PK for ${table}; pass --pk <col>`);
  return pk;
}

// --- gen-sql command ---

export interface GenOptions {
  pk?: string;
  filter?: string;
  mode: "full" | "missing";
  out: string;
  pageSize?: number;
  batch?: number;
  log?: (m: string) => void;
}

export interface GenResult {
  ok: boolean;
  file: string;
  table: string;
  mode: "full" | "missing";
  pk: string;
  filter?: string;
  srcRows: number;
  dstRowsBefore?: number;
  insertedRows: number;
  statements: number;
  bytes: number;
}

/** Generate a sync SQL file for ONE table (source → target). */
export async function genSyncSql(
  src: Ctx,
  dst: Ctx,
  table: string,
  opts: GenOptions,
): Promise<GenResult> {
  const log = opts.log ?? (() => undefined);
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const batch = opts.batch ?? 200;

  const pk = await mustPk(src, table, opts.pk);
  const cols = await columns(src, table);
  if (!cols.includes(pk)) throw new Error(`pk column "${pk}" not in ${src.env}.${table} columns`);

  const colsList = cols.map((c) => quoteIdent(c)).join(", ");
  const dstPk = opts.mode === "missing" ? new Set<string>() : null;
  if (opts.mode === "missing") {
    const d = await fetchAll(dst, table, pk, { pageSize });
    d.rows.forEach((r) => dstPk!.add(String(r[d.cols.indexOf(pk)])));
    log(`[gen] ${table}: target has ${dstPk!.size} rows (mode=missing, only new pk inserted)`);
  }

  log(`[gen] ${table}: fetching ${src.env} rows...`);
  const s = await fetchAll(src, table, pk, { filter: opts.filter, pageSize });
  const pkIdx = cols.indexOf(pk);
  const filteredRows =
    opts.mode === "missing" ? s.rows.filter((r) => !dstPk!.has(String(r[pkIdx]))) : s.rows;

  const header = [
    `-- =============================================================================`,
    `-- ${table} 数据同步:${src.env} → ${dst.env}(${opts.mode}模式, ${filteredRows.length} 行)`,
    `-- 源库:${src.env}  ${src.instance}  库=${src.db}`,
    `-- 目标:${dst.env}  ${dst.instance}  库=${dst.db}`,
    `--`,
    `-- 方式:${opts.mode === "full" ? "先 DELETE 清空目标表,再 INSERT 源全量(使两环境完全一致)" : "只 INSERT 源有而目标缺失(按主键)的行,保留目标独有行"}`,
    ...(opts.filter ? [`-- 过滤:${opts.filter}`] : []),
    ...(opts.mode === "full" ? [`--   含源表软删/全部行;保留原主键。事务包裹,失败整体回滚。`] : []),
    `-- =============================================================================`,
  ].join("\n");

  const stmts: string[] = [];
  stmts.push("START TRANSACTION;");
  if (opts.mode === "full") stmts.push(`DELETE FROM ${quoteIdent(table)};`);
  for (let i = 0; i < filteredRows.length; i += batch) {
    const chunk = filteredRows.slice(i, i + batch);
    const values = chunk.map((r) => "(" + r.map(sqlLiteral).join(", ") + ")").join(",\n");
    stmts.push(`INSERT INTO ${quoteIdent(table)}\n(${colsList})\nVALUES\n${values};`);
  }
  stmts.push("COMMIT;");

  const body = stmts.join("\n\n");
  const content = `${header}\n\n${body}\n`;
  fs.writeFileSync(opts.out, content, "utf8");

  log(`[gen] ${table}: wrote ${opts.out} (${filteredRows.length} rows, ${stmts.length} statements)`);
  return {
    ok: true,
    file: opts.out,
    table,
    mode: opts.mode,
    pk,
    filter: opts.filter,
    srcRows: s.rows.length,
    dstRowsBefore: dstPk ? dstPk.size : undefined,
    insertedRows: filteredRows.length,
    statements: stmts.length,
    bytes: Buffer.byteLength(content),
  };
}

// --- CLI ---

interface CliArgs {
  rest: string[];
  flags: Record<string, string>;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const rest: string[] = [];
  const flags: Record<string, string> = {};
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      flags[arg.slice(2)] = v;
      continue;
    }
    rest.push(arg);
  }
  return { rest, flags, help };
}

const HELP = `table-sync — 对比两个环境的表数据并生成手动执行的同步 SQL(两侧走 archery 只读)

Usage:
  mycastle table-sync diff    --src-instance "<name>" --dst-instance "<name>" --db <db> --tables t1,t2 [options]
  mycastle table-sync gen-sql --src-instance "<name>" --dst-instance "<name>" --db <db> --tables t1,t2 --out <file.sql> [options]

Commands:
  diff     按单列主键对比两环境 → JSON 报告(源独有 id / 目标独有 id / 共存值有差异的字段)
  gen-sql  生成同步 SQL 文件(手动执行,不直连目标库)

Options:
  --src-env <name>     源环境名(默认 prd)
  --dst-env <name>     目标环境名(默认 test)
  --src-instance <name>  源 archery 实例名(必填,先 mycastle archery instances 查看)
  --dst-instance <name>  目标 archery 实例名(必填)
  --db <db>            两侧库名(必填)
  --tables t1,t2       表清单(必填,逗号分隔,不带库前缀)
  --out <path>         (gen-sql) 输出 .sql 文件路径(必填)
  --mode full|missing  (gen-sql) full=清空+全量(默认); missing=只插源有目标缺的行
  --filter '<where>'   SQL WHERE 片段,两侧同用(如 "platform='example' and site='CA'")
  --pk <col>           指定主键列(默认自动探测单列主键)
  --page-size N        游标分页大小(默认 2000)
  --batch N            INSERT 批大小(默认 200)
  --config <path>      覆盖 .myws/archery.config.json
  -h, --help           帮助

Examples:
  # 检查两张表在 prd vs test 的差异
  table-sync diff --src-instance "<src-prod-instance>" \\
    --dst-instance "<dst-instance>" --db <db> \\
    --tables table_a,table_b

  # 生成某表全量同步 SQL(先清空目标表再全量)
  table-sync gen-sql --src-instance "<src-prod-instance>" \\
    --dst-instance "<dst-instance>" --db <db> \\
    --tables table_a --mode full --out sync.sql

  # 生成某条件下的增量(缺失)同步 SQL
  table-sync gen-sql --src-instance "<src-prod-instance>" \\
    --dst-instance "<dst-instance>" --db <db> \\
    --tables table_a --mode missing \\
    --filter "status='1' and type='A'" --out sync-missing.sql

Secrets come only from .myws/archery.config.json (gitignored).
`;

function need(flags: Record<string, string>, key: string): string {
  const v = flags[key];
  if (!v) throw new Error(`--${key} is required`);
  return v;
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
  if (args.help || args.rest.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const [command] = args.rest;
  if (command !== "diff" && command !== "gen-sql") {
    process.stderr.write(`error: unknown command "${command}" (expected diff|gen-sql)\n`);
    process.exit(2);
  }

  const log = (m: string): void => {
    process.stderr.write(m + "\n");
  };

  try {
    const cfg = loadArcheryConfig({ configPath: args.flags.config });
    const srcEnv = args.flags["src-env"] ?? "prd";
    const dstEnv = args.flags["dst-env"] ?? "test";
    const srcInst = need(args.flags, "src-instance");
    const dstInst = need(args.flags, "dst-instance");
    const db = need(args.flags, "db");
    const tables = need(args.flags, "tables")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (tables.length === 0) throw new Error("--tables parsed to zero tables");
    const common = {
      pk: args.flags.pk,
      filter: args.flags.filter,
      pageSize: Number(args.flags["page-size"]) || 2000,
    };

    const src = openCtx(srcEnv, srcInst, db, cfg);
    const dst = openCtx(dstEnv, dstInst, db, cfg);

    if (command === "diff") {
      const report = await diffTables(src, dst, tables, { ...common, log });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }

    const out = need(args.flags, "out");
    const mode = args.flags.mode === "missing" ? "missing" : "full";
    const results = [];
    for (const table of tables) {
      results.push(
        await genSyncSql(src, dst, table, {
          ...common,
          mode,
          out,
          batch: Number(args.flags.batch) || 200,
          log,
        }),
      );
    }
    process.stdout.write(JSON.stringify({ ok: true, tables: results }, null, 2) + "\n");
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}
