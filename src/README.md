# src/ — mycastle tools

跨平台 TypeScript 工具(Node 20+,ESM)。**一份 `.ts` 在 Windows / macOS / Linux 上都能跑**,平台差异统一收敛在 `lib/platform.ts`。`tsc` 编译到 `dist/`,`cli.ts` 路由 `mycastle <command>` 到各工具的 `run(argv)`。

## 工具索引

| 命令 | 源文件 | 一句话 | 文档 |
|---|---|---|---|
| `mycastle hello` | `hello.ts` | 冒烟测试,验证可跑 | — |
| `mycastle env` | `env-info.ts` | 打印当前 shell/OS/工具链 + 引号与 JSON 解析速查表 | [env-info.md](env-info.md) |
| `mycastle changes` | `repo-changes.ts` | 采集本地仓库自上次以来的改动 → 结构化 JSON | [repo-changes.md](repo-changes.md) |
| `mycastle kibana` | `kibana.ts` | Kibana REST API 只读 CLI(空间 / data views) | [kibana.md](kibana.md) |
| `mycastle xxljob` | `xxljob.ts` | XXL-Job admin 只读 CLI(会话 / 执行器 / 任务 / 快照,多环境) | [xxljob.md](xxljob.md) |
| `mycastle xxljob-scan` | `xxljob-scan.ts` | 离线扫描 Java 源码的 xxl-job handler 声明 → 结构化 JSON | [xxljob-scan.md](xxljob-scan.md) |
| `mycastle archery` | `archery.ts` | Archery 数据端只读 CLI(会话 / Schema 浏览 / 工单 / 查询历史 / SELECT 执行,多环境) | [archery.md](archery.md) |
| `mycastle mysql` | `mysql-helper.ts` | MySQL 查看 + DDL 执行 CLI(库 / 表 / 表结构 / 执行 SQL 脚本,连接走 `DB_CONN_URL` 或 `.myws/db.config.json`) | [mysql-helper.md](mysql-helper.md) |

工作区运行:`mycastle <command> [args]`(在 `.myws/` 配置就绪后)。开发直跑:`tsx src/<name>.ts`。

## 结构

| 路径 | 作用 |
|---|---|
| `cli.ts` | 命令路由:init / self-update + 工具名 → `src/<tool>.js` |
| `commands/` | `init.ts`(脚手架 + 调 `skills` CLI 装技能) / `self-update.ts` |
| `lib/platform.ts` | 跨平台公共工具(OS 判断、配置目录 `configDir`、`ensureDir`),所有工具复用 |
| `lib/*.ts` | 各工具 helper(`kibana-client` / `kibana-config` / `xxljob-client` / `xxljob-config` / `xxljob-session` / `archery-client` / `archery-config` / `archery-session` / `mysql-client` / `mysql-config` / `repos-config` / `git-collect` / `state`) |

## 开发约定

- 改完 `npm run build`(`tsc` → `dist/`),再 `node dist/cli.js <cmd>` 验证。
- 类型检查:`npm run typecheck`(`tsc --noEmit`,strict)。
- import 用 `.js` 后缀(NodeNext/ESM 要求;源码虽是 `.ts`,写 `from "./lib/x.js"`)。
- 路径一律用 `node:path` 的 `path.join(...)`,**不要手拼** `/` 或 `\`。
- 平台相关分支统一放 `lib/platform.ts`,业务工具保持平台无关。
- 密钥 / 令牌只从环境变量或工作区 `.myws/*.config.json` 读(包内不含任何密钥)。
- 工具**只采集、输出结构化 JSON,不做摘要**(由 agent 写概要;详见 [repo-changes.md](repo-changes.md))。
