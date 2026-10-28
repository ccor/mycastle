# table-sync — 对比两个环境的表数据并生成同步 SQL

> 代码:`src/table-sync.ts`(复用 `src/lib/archery-client.ts` / `src/lib/archery-config.ts` / `src/lib/data-sync.ts` 的 `quoteIdent`/`sqlLiteral`)

对比两个 archery 环境的表数据(默认 prd → test),并按需生成**手动执行**的同步 SQL。两侧都只读走 Archery,不直连数据库、不执行任何写操作。

- **diff**:按单列主键逐表对比 → JSON 报告(源独有 id / 目标独有 id / 共存但值有差异的行及字段)。
- **gen-sql**:把源表数据导出为 .sql 文件,供你在目标环境手动执行:
  - `--mode full`:先 `DELETE` 清空目标表再 `INSERT` 源全量(使两环境完全一致,含软删行)。
  - `--mode missing`:只 `INSERT` 源有而目标缺失(按主键)的行,保留目标独有行。

## 用法

```powershell
mycastle table-sync diff --src-instance "<源实例>" --dst-instance "<目标实例>" --db <db> --tables t1,t2 [--filter '<where>'] [--pk <col>]
mycastle table-sync gen-sql --src-instance "<源实例>" --dst-instance "<目标实例>" --db <db> --tables t1,t2 --out <file.sql> [--mode full|missing] [--filter '<where>'] [--pk <col>]
```

- 实例名为 archery 实例名(先 `mycastle archery instances` 查看;提单视角的实例用 `instances --group`)。
- 环境名:`--src-env`(默认 `prd`)、`--dst-env`(默认 `test`)。
- `--filter` 是 SQL WHERE 片段,同时作用于源/目标两侧(如 `"status='1' and type='A'"`)。
- `--pk` 缺省时自动探测单列主键;复合主键需显式指定。
- `--config <path>` 覆盖 `.myws/archery.config.json`。

## 示例

```powershell
# 1. 检查两张表在 prd vs test 的差异
mycastle table-sync diff --src-instance "<src-prod-instance>" `
  --dst-instance "<dst-instance>" --db <db> `
  --tables table_a,table_b

# 2. 生成某表全量同步 SQL(先清空再全量)
mycastle table-sync gen-sql --src-instance "<src-prod-instance>" `
  --dst-instance "<dst-instance>" --db <db> `
  --tables table_a --mode full --out sync.sql

# 3. 生成某条件下的增量(缺失)同步 SQL
mycastle table-sync gen-sql --src-instance "<src-prod-instance>" `
  --dst-instance "<dst-instance>" --db <db> `
  --tables table_a --mode missing `
  --filter "status='1' and type='A'" --out sync-missing.sql
```

生成后手动执行(注意表字符集 utf8/utf8mb4,客户端连接需 UTF-8):

```powershell
mycastle mysql execute <file.sql> --db <db> --dry-run   # 预览
mycastle mysql execute <file.sql> --db <db>             # 执行
```

## 约定与注意

- 值比较的归一化:`NULL` 与空串视为不同(`\u0000NULL` vs `\u0000EMPTY`);数值/字符串按文本比较。
- `diff` 只对比**两侧都有的列**;列集合差异单独报告在 `columns.srcOnly/dstOnly`。
- 输出为结构化 JSON(stdout),进度写 stderr;不做任何摘要。
- 敏感列(如账号表的 password/密钥)按需导出,文件勿入库、妥善保管。
- `--mode full` 含 `DELETE`,执行前请自行确认目标环境可接受清空。
- 工单/执行链路参考 `archery.md` §5;生成文件里的事务语句(`START TRANSACTION`/`COMMIT`)喂给 `workflow submit` 时会被自动剥离(见 archery.md §5)。

## 同相关工具

- `mycastle archery`:底层只读查询 / 表结构浏览 / 工单提交。
- `mycastle data-sync`:源 → mysql 目标**直写**同步(不生成文件);本工具面向「只能经 archery 读、手动执行」的场景。
