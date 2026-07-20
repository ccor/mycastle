# MySQL 查看 + DDL 执行 CLI（show-databases / show-tables / describe / execute）

> 代码:`mysql-helper.ts` + `lib/mysql-client.ts` + `lib/mysql-config.ts`

本仓库的 `src/mysql-helper.ts` 是对 MySQL 的**查看 + DDL 执行**封装:列出数据库、列出表、查看表结构、执行 SQL 脚本(DDL/迁移)。基于 `mysql2/promise`,查看类每次开一条短连接后即关闭(无连接池);`execute` 在**单连接**上顺序执行多条语句,失败即停(fail-fast)。

> 工具**只采集、输出结构化 JSON 到 stdout**(默认 pretty,`--compact` 单行),不做摘要。

## 1. 配置连接

**优先级:环境变量 `DB_CONN_URL` > `.myws/db.config.json`**。真实地址/密码只在这两处,绝不进命令行(无 `--password` flag)。

### 方式 A:环境变量(最高优先级)

```powershell
$env:DB_CONN_URL = "mysql://user:password@host:3306/database?charset=utf8mb4"
mycastle mysql show-databases
```

连接 URL 格式:

```
mysql://user:password@host:port/database?charset=utf8mb4
```

也兼容 `mysql+pymysql://` / `mysql+aiomysql://` 前缀(自动归一化为 `mysql://`)。`port` 省略时默认 `3306`,`charset` 省略时默认 `utf8mb4`,`database` 可省略。密码含特殊字符时按 URL 编码(如 `@` → `%40`)。

### 方式 B:配置文件 `.myws/db.config.json`(gitignored)

单连接(扁平):

```jsonc
{
  "url": "mysql://user:password@host:3306/database?charset=utf8mb4"
}
```

多连接(命名,可用 `--conn` 切换):

```jsonc
{
  "default": "test",
  "connections": {
    "test": { "url": "mysql://user:pass@10.0.0.1:3306/db_test?charset=utf8mb4" },
    "dev":  { "url": "mysql://user:pass@10.0.0.2:3306/db_dev" }
  }
}
```

- `default`:`--conn` 缺省时取它,否则首个连接。
- 设了 `DB_CONN_URL` 环境变量时,**忽略**配置文件与 `--conn`。

> `.myws/db.config.json` 已 gitignore;schema 与占位示例只在本节,不建 `.example`。

## 2. 用法

```powershell
mycastle mysql show-databases                              # 列出用户库(过滤系统库)
mycastle mysql show-databases --compact                    # 单行 JSON

mycastle mysql show-tables mydb                     # 列出某库的表(位置参数)
mycastle mysql show-tables --db mydb                # 等价(--db)
mycastle mysql show-tables                                 # 用连接 URL 里的 database

mycastle mysql describe mydb.items                    # 表结构:<db>.<table>
mycastle mysql describe items --db mydb               # 等价(bare table + --db)
mycastle mysql describe items                                # 用连接 URL 里的 database

# 执行 SQL 脚本(DDL / 迁移)
mycastle mysql execute docs/.../foo.ddl.sql --conn dev          # 执行,失败即停
mycastle mysql execute docs/.../foo.ddl.sql --conn dev --dry-run   # 只解析预览,不执行

# 多连接配置 + --conn 切换
mycastle mysql show-databases --conn dev
mycastle mysql describe mydb.t1 --conn dev

# 直跑
mycastle mysql-helper <command> [options]
```

### 全局选项

| 选项 | 说明 |
|---|---|
| `--db <name>` | 默认库(覆盖连接 URL 里的 database) |
| `--conn <name>` | 命名连接(仅多连接配置文件有效;`DB_CONN_URL` 环境变量时忽略) |
| `--config <path>` | 覆盖 `.myws/db.config.json` 路径 |
| `--dry-run` | (仅 `execute`)解析脚本并列出语句,不执行 |
| `--compact` | 单行 JSON(默认 pretty) |
| `-h, --help` | 帮助 |

### 表名格式

`<database>.<table>` 或单独 `<table>` 配合 `--db`:

```bash
describe mydb.items          # db=mydb
describe items --db mydb     # 等价
```

## 3. JSON 输出示例

```jsonc
// show-databases
{ "connection": "DB_CONN_URL", "databases": ["app", "mydb", "logs"] }

// show-tables
{ "connection": "DB_CONN_URL", "database": "mydb", "tables": ["items", "orders", "users"] }

// describe
{
  "connection": "DB_CONN_URL",
  "database": "mydb",
  "table": "items",
  "columns": [
    { "Field": "id",   "Type": "bigint(20)",   "Null": "NO",  "Key": "PRI", "Default": null, "Extra": "auto_increment" },
    { "Field": "code", "Type": "varchar(64)",  "Null": "NO",  "Key": "UNI", "Default": null, "Extra": "" }
  ]
}

// execute --dry-run
{
  "connection": "dev", "database": "mydb", "file": ".../foo.ddl.sql", "dryRun": true,
  "statementCount": 4,
  "statements": [
    { "index": 0, "sql": "CREATE TABLE `t1` (...) ENGINE=InnoDB ..." },
    { "index": 1, "sql": "CREATE TABLE `t2` (...) ENGINE=InnoDB ..." }
  ]
}

// execute (fail-fast: 前两条成功,第三条报错)
{
  "connection": "dev", "database": "mydb", "file": ".../foo.ddl.sql",
  "statementCount": 4, "executed": 3,
  "results": [
    { "index": 0, "ok": true,  "sql": "CREATE TABLE `t1` ...", "affectedRows": 0, "message": "", "elapsedMs": 120 },
    { "index": 1, "ok": true,  "sql": "CREATE TABLE `t2` ...",        "affectedRows": 0, "message": "", "elapsedMs": 90 },
    { "index": 2, "ok": false, "sql": "CREATE TABLE `t3` ...",         "affectedRows": 0, "message": "", "error": "ER_TABLE_EXISTS_ERROR: Table 't3' already exists", "elapsedMs": 5 }
  ]
}
```

**类型序列化**(连接层已配置,每行均为 JSON-safe):
- `DATE` / `DATETIME` / `TIMESTAMP` → 字符串(`YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS`)。
- `BIGINT` → 字符串(避免大数精度丢失)。
- `BLOB` / 二进制 → `0x` 前缀 hex 字符串。

## 4. 在脚本里复用客户端

```ts
import { resolveConnection } from "./lib/mysql-config.js";
import { MysqlHelper, splitSqlStatements } from "./lib/mysql-client.js";

const { config } = resolveConnection();          // 读 DB_CONN_URL 或 .myws/db.config.json
const helper = new MysqlHelper(config);
const tables = await helper.showTables("mydb");
const cols   = await helper.describeTable("items", "mydb");
const rows   = await helper.query("SELECT * FROM `items` LIMIT 5", "mydb");

// 执行脚本:先 split,再 executeStatements(单连接、fail-fast)
const stmts = splitSqlStatements(fs.readFileSync("foo.ddl.sql", "utf8"));
const results = await helper.executeStatements(stmts, "mydb");
```

## 5. 注意

- **查看类只读**:`show-databases` / `show-tables` / `describe` 仅 `SHOW` / `DESCRIBE`;`execute` 是写入口,执行用户提供的 SQL 脚本(DDL/迁移/任意语句),需自行确保脚本安全。
- **execute 语义**:在**单连接**上**顺序**执行 split 出的语句;**fail-fast**——遇错即停,返回已执行结果(含失败那条的 `error`)。MySQL DDL 自动提交,失败前的语句已生效,需手动回滚(如 `DROP TABLE`)后重跑。
- **SQL 切分**:`splitSqlStatements` 按 `;` 切分,正确处理单引号字符串(`''` 转义)、反引号标识符、`--`/`#` 行注释、`/* */` 块注释;无 `;` 结尾的末条语句也会返回。
- **短连接**:查看类每次新建连接、用完即关(与 Python 版一致);不做连接池复用。
- **系统库过滤**:`show-databases` 默认排除 `information_schema` / `mysql` / `performance_schema` / `sys`。
- **数据库必填**:`show-tables` / `describe` / `execute` 需要有库(位置参数、`--db`、或连接 URL 里的 database 三者其一),否则报错退出。
- **依赖**:`mysql2`(唯一外部依赖;已在 `package.json` 声明)。
