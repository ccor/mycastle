# 通过 Archery 接口脚本化访问数据端(只读,多环境)

> 代码:`archery.ts` + `lib/archery-client.ts` + `lib/archery-config.ts` + `lib/archery-session.ts`

本仓库的 `src/archery.ts` 是对 Archery(SQL 审核平台)**数据端**的只读封装:Django 会话(登录/登出/sessionid+csrftoken 持有)、Schema 浏览(实例→库→表→列/表结构)、上线工单列表、查询历史、SELECT 执行(服务端强制只读),支持 test/dev/prd 多环境并存。基于 Node 20+ 全局 `fetch`,**零额外依赖**。

> 调研期默认环境:test。真实地址只在本机 gitignored 的配置里。

## 1. 配置 `.myws/archery.config.json`(gitignored)

真实 URL / 账号 / 密码**只**在此文件;schema 与占位示例只在本节,**不建 `.example`**。

```jsonc
{
  "default": "test",
  "envs": {
    "test": { "url": "http://archery.test.example.com", "username": "********", "password": "********" }
    // dev / prd 按需补,环境名任意(不限于 test/dev/prd)
  }
}
```

- `envs`:环境名 → `{ url, username, password }`,环境名任意。
- `default`:`--env` 缺省时取它,否则首个 env。
- 会话 token 按环境存到 `<configDir>/archery-session-<env>.json`(Windows 为 `%LOCALAPPDATA%\mycastle`)。

> 密钥绝不进命令行(无 `--password` flag);只从本配置文件读。

> ⚠️ **不要直接读取 `.myws/archery.config.json` 来枚举环境**——文件内容(含密码)会进入 agent 上下文并发往模型服务端。枚举用 `mycastle archery envs`:输出每个环境的 name/url/username(URL 内嵌的凭证会被剥除),永不输出密码。

## 2. 用法

```powershell
mycastle archery envs                                                       # 列出环境名 + URL + 用户名(不含密码)
mycastle archery login --env test                                           # 登录并持久化会话
mycastle archery status --env test                                          # 连通性 / 认证探针
mycastle archery instances --env test                                       # 当前账号可访问的实例(can_read,默认)
mycastle archery instances --tag can_execute --env test                     # 按权限 tag 过滤(can_read|can_execute|can_audit|can_modify)
mycastle archery databases --instance "<instance>" --env test                  # 实例下的库
mycastle archery tables --instance "<instance>" --db db_sample --env test         # 库下的表
mycastle archery columns --instance "<instance>" --db db_sample --table sample_orders --env test   # 表的列
mycastle archery describe --instance "<instance>" --db db_sample --table sample_orders --env test  # 表结构
mycastle archery query --instance "<instance>" --db db_orders --sql 'select * from sample_records' --limit 100 --env test
mycastle archery workflow list --env test                                   # 上线工单列表
mycastle archery workflow list --status workflow_finish --from 2026-06-01 --to 2026-07-02 --env test
mycastle archery querylog list --env test                                   # 查询历史
mycastle archery logout --env test                                          # 清本地会话
```

多环境:`--env all` 或 `--env test,dev` 一次跑多个,输出按键聚合 `{"test":{...},"dev":{...}}`,单环境失败不中断其余(置 `{"error":"..."}`)。

- 默认 pretty JSON;`--compact` 单行。`--config <path>` 覆盖配置路径。
- `--instance` 为**实例名**(如 `test-mysql-01`;由 Archery 实例配置决定,中文/英文均可);`--from/--to` 为 `YYYY-MM-DD`。
- `workflow list --status` 取**英文状态 key**(如 `workflow_finish` / `workflow_abort`),**非**中文标签(实测 `已执行` 不匹配)。

## 3. 会话与 CSRF(Django 双提交)

- Archery 是 Django,采用 session + CSRF 双提交:`sessionid` cookie 维持登录态;每个 POST 须额外带 `X-CSRFTOKEN` 头,值 = `csrftoken` cookie。
- 登录三步:`GET /login/`(种 `csrftoken`)→ `POST /authenticate/`(form 账号+密码,头 `X-CSRFTOKEN`)→ 抓 `sessionid` + 轮换后的 `csrftoken`,按环境落盘。
- 命令执行前若本地无会话,自动登录(`ensureSession`)。
- 受保护请求被重定向到登录页(会话失效)→ 自动用配置账密重登一次并重试(`send` + `isLoginPage`)。
- 登录的请求用 `redirect: manual` 以抓原始 `Set-Cookie`;其余请求 `follow`。

## 4. 在脚本里复用客户端

```ts
import { ArcheryClient } from "./lib/archery-client.js";

const c = new ArcheryClient({
  env: "test",
  baseUrl: "http://archery.test.example.com",
  username: "...",
  password: "...",
});
await c.ensureSession();
const rows = await c.query.run({ instance: "<instance>", db: "db_orders", sql: "select * from sample_records", limit: 100 });
```

出错抛 `ArcheryApiError`,带 `status` / `body` / `url` / `env`(传输/超时 `status` 为 `0`)。

## 5. 注意(调研期 test 实测)

- **只读**:不提交/审核/执行工单;`query` 仅跑用户给的 SQL,Archery 服务端强制只 SELECT。
- **`instances` 是"可访问视图"非全量清单**:`/group/user_all_instances/?tag_codes[]=can_read` 返回**当前账号在其分组权限内能访问**的实例(SQL 查询页下拉框同源),不是管理员视角的全部配置实例。只读/审计账号通常 `can_read` 全开、`can_execute`/`can_audit`/`can_modify` 为空。要拿 `--instance` 的实例名,先跑 `instances`。
- **明文 HTTP**:内网走 `http://` 明文链路有泄露风险,留意是否有 HTTPS 入口。
- **CSRF 轮换**:登录后若服务端轮换 `csrftoken`,客户端用新值落盘,否则后续 POST 失效。
- **实例名编码**:实例名可能含中文等非 ASCII 字符,URL 与 form 编码需一致(`URLSearchParams` 统一处理),避免编码差异导致 404。
- **响应形状**:首轮真实调用后,工单状态枚举、`/query/` 结果行列结构等以实跑为准(见 spec §9)。
- **请求头**:带 `X-Requested-With` 与 `Referer`,贴近浏览器 ajax,避免被网关拦截。
