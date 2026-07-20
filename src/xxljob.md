# 通过 XXL-Job Admin 接口脚本化访问(只读,多环境)

> 代码:`xxljob.ts` + `lib/xxljob-client.ts` + `lib/xxljob-config.ts` + `lib/xxljob-session.ts`

本仓库的 `src/xxljob.ts` 是对 XXL-Job 调度控制台(xxl-job-admin)的只读封装:会话(登录/登出/cookie 持有)、执行器与任务查询、调度日志查询、本地快照,支持 dev/test/prd 多环境并存。基于 Node 20+ 全局 `fetch`,**零额外依赖**。

> 调研期默认环境:dev。真实地址只在本机 gitignored 的配置里。

## 1. 配置 `.myws/xxljob.config.json`(gitignored)

真实 URL / 账号 / 密码**只**在此文件;schema 与占位示例只在本节,**不建 `.example`**。

```jsonc
{
  "default": "dev",
  "envs": {
    "dev":  { "url": "http://xxl-dev.example.com/xxl-job-admin", "username": "admin",  "password": "********" },
    "test": { "url": "http://xxl-test.example.com/xxl-job-admin","username": "********","password": "********" },
    "prd":  { "url": "http://xxl-prd.example.com/xxl-job-admin", "username": "********","password": "********" }
  }
}
```

- `envs`:环境名 → `{ url, username, password }`,环境名任意(不限于 dev/test/prd)。
- `default`:`--env` 缺省时取它,否则首个 env。
- 会话 cookie 按环境存到 `<configDir>/xxljob-session-<env>.json`(Windows 为 `%LOCALAPPDATA%\mycastle`)。

> 密钥绝不进命令行(无 `--password` flag);只从本配置文件读。

## 2. 用法

```powershell
mycastle xxljob envs                         # 列出已配置的环境名(不泄密)
mycastle xxljob login --env dev              # 登录并持久化 cookie
mycastle xxljob status --env dev             # 连通性 / 认证探针
mycastle xxljob executors list --env dev     # 执行器列表
mycastle xxljob jobs list --group 2 --env dev           # 某执行器下全部任务(翻页拉满)
mycastle xxljob jobs list --group 2 --status 1 --env dev  # 仅运行中(triggerStatus=1)
mycastle xxljob jobs get 2204 --env dev      # 单任务详情
mycastle xxljob jobs log 1004 --group 2 --env dev       # 调度日志(须带 --group)
mycastle xxljob snapshot --env dev           # 快照执行器+任务到本地 JSON
mycastle xxljob logout --env dev             # 登出并清本地 cookie
```

多环境:`--env all` 或 `--env dev,test` 一次跑多个,输出按键聚合 `{"dev":{...},"test":{...}}`,单环境失败不中断其余(置 `{"error":"..."}`)。

- 默认 pretty JSON;`--compact` 单行。`--config <path>` 覆盖配置路径。
- 快照文件:`<configDir>/xxljob/snapshots/<env>/<时间戳>.json`(路径打到 stderr,snapshot JSON 打到 stdout)。

## 3. 会话与失效重登

- 登录后 cookie(`XXL_JOB_LOGIN_IDENTITY`)按环境落盘,后续命令自动复用。
- 命令执行前若本地无 cookie,自动登录(`ensureSession`)。
- 受保护请求被重定向到登录页(会话失效)→ 自动用配置账密重登一次并重试(`send` + `isLoginPage`)。
- 登录先按明文密码,失败再试 MD5(xxl-job 前端常 MD5)。dev 实测明文即通过。

## 4. 在脚本里复用客户端

```ts
import { XxljobClient } from "./lib/xxljob-client.js";

const c = new XxljobClient({
  env: "dev",
  baseUrl: "http://xxl-dev.example.com/xxl-job-admin",
  username: "admin",
  password: "...",
});
await c.ensureSession();
const jobs = await c.jobs.list({ group: 2 });
```

出错抛 `XxljobApiError`,带 `status` / `body` / `url` / `env`(传输/超时 `status` 为 `0`)。

## 5. 注意(调研期 dev 实测)

- **只读**:不触发/启停/增删改任务;「任务管理」在此仅指查询。
- **明文 HTTP**:内网走 `http://` 明文链路有泄露风险,留意是否有 HTTPS 入口。
- **调度日志不进快照**:快照只含执行器 + 任务配置;日志用 `jobs log` 按需查。
- **执行器数据源**:优先 `POST /jobgroup/pageList`(JSON);dev 实测该端点 **404**,故实际走 `GET /jobinfo` 页面 HTML 解析 `<option>`(页面把执行器 `<select>` 渲染了 3 份:过滤条 + 新增/编辑弹窗,故按 id 去重、丢弃 id≤0 占位项)。
- **`/joblog/pageList` 在 dev 极慢**:dev 后端对该端点任意任务均 >60s 超时(nginx 504),`jobs log` 实现符合标准 xxl-job 协议、请求格式正确(服务端 504 而非 400/404),但在 dev 无法在合理时间内取到响应;健康环境(test/prd)应正常。
- **`/jobinfo/loadById` 可用**:`jobs get` 走主路径(loadById)成功;不可用时回退从全量 list 过滤。
- **请求头**:带 `X-Requested-With: XMLHttpRequest` 与 `Referer`,贴近浏览器 ajax,避免被网关拦截。
