# data-sync — 表数据搬运 CLI(archery | mysql → mysql)

> 代码:`data-sync.ts` + `lib/data-sync.ts`

把若干张表从一个环境搬到另一个环境的小工具。**源端两种**:
- `archery` — 通过 Archery 平台只读拉取(用于受限环境,本机拿不到直连权限)
- `mysql` — 走 `mysql2` 直连(更快,需要源端有读权限)

**目标端恒为 mysql**,复用 `mysql-helper` 的 `.myws/db.config.json`。

> 工具只采集与搬运,**JSON 摘要输出到 stdout**,进度打到 stderr。

## 1. 配置

复用现有两份 gitignored 配置,**无新增**:

- `.myws/archery.config.json` —— archery 源用(envs/url/账号/密码)
- `.myws/db.config.json` —— mysql 源 + mysql 目标用(命名连接)

> ⚠️ 枚举环境/连接用 `mycastle archery envs` / `mycastle mysql conns`(输出脱敏,不含密码),不要直接读取这两份配置文件的原文。

## 2. 用法

```powershell
# archery prd.srcdb → local.destdb,3 张表,truncate,PK 自动识别
npm run data-sync -- copy `
  --src archery --src-env prd `
  --src-instance "prod-mysql-ro-01" `
  --src-db srcdb `
  --dst-conn local --dst-db destdb `
  --tables t1,t2,t3 `
  --yes

# mysql dev.srcdb.t1 → local.destdb.t1_copy(改名 + append,不动目标已有数据)
npm run data-sync -- copy `
  --src mysql --src-conn dev --src-db srcdb `
  --dst-conn local --dst-db destdb `
  --tables t1:t1_copy --mode append

# 先 dry-run 看双侧计数,不写
npm run data-sync -- copy ... --dry-run
```

### 全部选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--src archery\|mysql` | 必填 | 源端类型 |
| `--src-env <name>` | — | archery 源:在 `.myws/archery.config.json` 里配的环境名 |
| `--src-instance "<instance>"` | — | archery 源:实例名(先跑 `npm run archery -- instances --env prd` 拿到) |
| `--src-conn <name>` | — | mysql 源:`.myws/db.config.json` 命名连接 |
| `--src-db <name>` | 必填 | 源库 |
| `--dst-conn <name>` | 必填 | 目标命名连接 |
| `--dst-db <name>` | 必填 | 目标库 |
| `--tables t1,t2` 或 `src:dst,...` | 必填 | 表清单(逗号分隔;`src:dst` 改目标名) |
| `--mode truncate\|append` | `truncate` | 写模式:truncate=先清空再插;append=直接追加 |
| `--pk <col>` | 自动 | 游标列;缺省自动查 `information_schema.KEY_COLUMN_USAGE` 取单列主键 |
| `--page-size N` | `1000` | 游标每页行数 |
| `--batch N` | `200` | 单条 INSERT 解析的行数(批量占位符) |
| `--max-pages N` | `1000` | 单表页数安全上限 |
| `--yes` | false | 跳过 truncate 前的 `[y/N]` 确认 |
| `--auto-create` | false | 目标表不存在时,从源端 `SHOW CREATE TABLE` 拉 DDL 自动建表 |
| `--collate <name\|source>` | — | 与 `--auto-create` 配合:注入 `COLLATE` 到 DDL。默认走 dest DB 默认 collation,源/目标不一致时 abort(避免库内 collation 漂移);`--collate source` 注入源端 `TABLE_COLLATION`;`--collate <name>` 指定具体值 |
| `--dry-run` | false | 只计数 + 出 schema,不写 |
| `--compact` | false | 单行 JSON(默认 pretty) |
| `-h, --help` | — | 帮助 |

## 3. 游标分页

源端按 PK 游标滚动,避免一次性 `SELECT *` 在大表上爆内存或被 archery 服务端裁断:

```sql
-- 第 1 页
SELECT * FROM `tbl`              ORDER BY `pk` LIMIT <page>;
-- 第 n+1 页
SELECT * FROM `tbl` WHERE `pk`>c ORDER BY `pk` LIMIT <page>;
```

直到某页返回 `< page` 行结束。archery 源游标值通过 `sqlLiteral` 内联进 SQL;mysql 源走 `mysql2` 的 `?` 占位符。

**archery 服务端 limit 上限**:Archery 后端对单次 `limit_num` 有上限(常见 1000–10000,取决于部署)。`--page-size` 不要超过这个值;实测 5000 可行,默认 1000 安全。

## 4. 列与类型

- 列名顺序按源端 `information_schema.COLUMNS.ORDINAL_POSITION` 取;源端 `SELECT *` 行按列序对齐成位置数组后批量插入。
- **类型透传**:DATETIME/TIMESTAMP、BIGINT 都以字符串形式透传到目标,`mysql2` 端配 `dateStrings` + `bigNumberStrings`,目标列类型一致即可对齐。
- **NULL / 默认**:源列在目标不存在 → 直接报错(schema mismatch);目标多出来的列 → 走目标列默认值或 NULL。
- **BLOB / 二进制**:archery 源会通过 Django JSON 化,二进制可能丢失或变形;mysql→mysql 直连走 Buffer 透传。涉及二进制列建议用 mysql 源。
- **archery 脱敏**:若 Archery 配置了脱敏规则(`is_masked=true`),会输出 WARNING 但仍写入脱敏后的值。敏感表请人工核对脱敏策略。

## 5. 确认与 fail-fast

- **truncate 前**:若目标表已有数据且未传 `--yes`,**每张表**会在 stderr 上询问 `[y/N]`;答非 `y/yes` 则跳过该表(`skipped: true, reason: "declined-truncate"`),目标数据不动。
- **非交互 stdin**(管道、agent 调用)直接拒绝,要求显式 `--yes`。
- **任一失败(fetch/TRUNCATE/insert/schema 不匹配)**:整体退出 1,`ok: false`,`error` 字段给原因,**之前已 truncate 的表不会回滚**(TRUNCATE 是 DDL)。重跑前需自行核账。

## 6. JSON 输出示例

```jsonc
// 单次 copy 的最终摘要(pretty)
{
  "ok": true,
  "src": { "kind": "archery", "label": "archery:prd/srcdb" },
  "dst": { "label": "mysql:local/destdb" },
  "mode": "truncate",
  "dryRun": false,
  "tables": [
    {
      "srcTable": "t1",
      "dstTable": "t1",
      "pk": "id",                       // 自动识别
      "pages": 1,
      "srcRows": 769,                   // 源 COUNT(*)
      "dstRowsBefore": 768,             // 同步前目标 COUNT(*)
      "dstRowsAfter": 769,              // 同步后目标 COUNT(*)
      "masked": false,                  // archery 脱敏命中?
      "mode": "truncate",
      "dryRun": false,
      "skipped": false,
      "insertedRows": 769,              // 累计 INSERT affected rows
      "autoCreated": false,             // --auto-create 触发过吗
      "elapsedMs": 955
    }
    // ...
  ],
  "elapsedMs": 3048
}
```

`skipped: true` 时附带 `reason`:`dry-run` / `declined-truncate`。失败时 `ok: false` + `error` + `failedTable`。

## 7. 在脚本里复用

```ts
import {
  openSource, openDest, syncTables, parseTableList,
} from "./tools/lib/data-sync.ts";

const src = await openSource({
  kind: "archery",
  env: "prd",
  instance: "prod-mysql-ro-01",
  db: "srcdb",
});
const dst = await openDest({ conn: "local", db: "destdb" });

try {
  const summary = await syncTables(src, dst, parseTableList("t1,t2:t2_copy"), {
    mode: "truncate",
    pageSize: 1000,
    batchSize: 200,
    maxPages: 1000,
    yes: true,
    dryRun: false,
    log: (m) => process.stderr.write(m + "\n"),
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await src.close();
  await dst.close();
}
```

`Source` / `Dest` 都是 interface —— 自定义源(比如 PostgreSQL、CSV)只需实现同样方法即可挂进 `syncTables`。

## 8. 注意

- **DDL 同步**:默认不做。目标表必须预先存在;若不存在,加 `--auto-create` 让工具从源端 `SHOW CREATE TABLE` 拉一份 DDL 在目标库执行。若同时用 `src:dst` 改名,工具会把 DDL 文本里 `CREATE TABLE \`src\`` 的表名直接改写成 `dst`(只改头部表名,不动列定义/约束),避免 CREATE+RENAME 在目标库与已有同名表冲突。`--auto-create` 只在表完全缺失时触发,**不会 DROP 已有表**(避免误删)。
- **Collation 策略(避免库内漂移)**:`--auto-create` 默认让新表跟随 **dest DB 默认 collation**(`information_schema.SCHEMATA.DEFAULT_COLLATION_NAME`)。若源端表的 collation 与 dest DB 默认不同(典型:prd MySQL 5.7 `utf8mb4_general_ci` → 本地 MySQL 8 `utf8mb4_0900_ai_ci`),工具会**拒绝并 abort**,给出 3 个选项让你选:
  1. **统一 dest DB**:跑一次 `ALTER DATABASE <dst_db> COLLATE <src_collation>`,然后无需任何 flag(推荐,库内 collation 一致);
  2. **单表注入**:`--collate source`,把源 collation 注入这条 DDL(会跟库内其他表 collation 不同);
  3. **强制 dest 默认**:`--collate <dest_default>`,接受 dup-key 风险。

  这么设计是因为 **collation 是 DB 级而非表级的决定**——每张表自带不同 collation 会导致跨表 JOIN 报 `Illegal mix of collations`。DDL 里若已经显式带 `COLLATE`(表级或列级),工具不动。
- **不缓存到本地文件**:数据在内存中按页流转。`--batch` 控制单条 INSERT 的行数;单页行数过大(几十万)可能 OOM。常规配置表无忧,真大表请把 `--page-size` 调小。
- **archery 源受平台限速**:每页一次 HTTP 调用,大表建议 `--page-size 1000`(默认)而非更小。
- **多次重跑**:truncate 模式幂等;append 模式会累加,慎用。
- **游标列必须有序且唯一**:用 PK 最稳;用非唯一列(如 `created_at`)会丢数据(同值跨页跳过)。复合 PK 不支持(自动识别会拒绝,需 `--pk` 显式指定单列)。
