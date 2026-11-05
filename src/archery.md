# 通过 Archery 接口脚本化访问数据端(多环境)

> 代码:`src/archery.ts` + `src/lib/archery-client.ts` + `src/lib/archery-config.ts` + `src/lib/archery-session.ts`

`mycastle archery` 是对 Archery(SQL 审核平台)**数据端**的封装:Django 会话(登录/登出/sessionid+csrftoken 持有)、Schema 浏览(实例→库→表→列/表结构)、上线工单列表、查询历史、SELECT 执行(服务端强制只读),以及**工单提交链路**(sqlcheck 审核 / submit 建单 / content 明细 / execute 执行 / cancel 终止,默认 dry-run,见 §5),支持 test/dev/prd 多环境并存。基于 Node 20+ 全局 `fetch`,**零额外依赖**,Linux / macOS / Windows 通用。

> 真实地址只在本机 gitignored 的配置里。

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
mycastle archery instances --env test                                    # 当前账号可访问的实例(查询视角)
mycastle archery instances --group "<group>" --env test                  # 某组的实例(提交视角,默认 can_write=可提单)
mycastle archery workflow groups --env test                             # 提交工单可用的组(id→名称)
mycastle archery workflow sqlcheck --instance "<instance|id>" --db db_sample --sql-file x.sql --env test   # 只审核,不建单
mycastle archery workflow submit --instance "<instance|id>" --db db_sample --group-id <group-id> --name "<ticket-name>" --sql-file x.sql --env test   # 默认 dry-run,--yes 建单
mycastle archery workflow content --workflow-id <id> --env test        # 工单语句明细
mycastle archery workflow execute --workflow-id <id> --yes --env test  # 立即执行(走平台执行入口,受状态/权限约束)
mycastle archery workflow execute --workflow-id <id> --yes --wait --interval 15 --max-wait 3600 --env test  # 执行并轮询到终态
mycastle archery workflow wait --workflow-id <id> --env test           # 轮询工单到终态(可重入,进度走 stderr)
mycastle archery workflow cancel --workflow-id <id> --remark "不要了" --yes --env test  # 终止
mycastle archery workflow list --instance "<instance>" --group "<group>" --from 2026-09-09 --to 2026-10-08 --env prd  # 名字自动解析 id
mycastle archery workflow list --env test                                   # 上线工单列表
mycastle archery workflow list --status workflow_finish --from 2026-06-01 --to 2026-07-02 --env test
mycastle archery querylog list --env test                                   # 查询历史
mycastle archery logout --env test                                          # 清本地会话
```

多环境:`--env all` 或 `--env test,dev` 一次跑多个,输出按键聚合 `{"test":{...},"dev":{...}}`,单环境失败不中断其余(置 `{"error":"..."}`)。

- 默认 pretty JSON;`--compact` 单行。`--config <path>` 覆盖配置路径。
- `--timeout <ms>` 单请求超时(默认 30000),慢聚合可放宽。
- `--instance` 为**实例名**(以 `mycastle archery instances` 输出为准,中文/英文均可);`--from/--to` 为 `YYYY-MM-DD`。
- `workflow wait` / `execute --wait`:`--interval <s>` 轮询间隔(默认 15)、`--max-wait <s>` 总预算(默认 3600,0=不限);进度行走 **stderr**,最终快照 JSON 走 **stdout**;已终态的工单首拍即返回,中断后重跑同一命令可续等。
- `workflow list --status` 取**英文状态 key**(如 `workflow_finish` / `workflow_abort`),**非**中文标签(中文标签不匹配)。

## 3. 会话与 CSRF(Django 双提交)

- Archery 是 Django,采用 session + CSRF 双提交:`sessionid` cookie 维持登录态;每个 POST 须额外带 `X-CSRFTOKEN` 头,值 = `csrftoken` cookie。
- 登录三步:`GET /login/`(种 `csrftoken`)→ `POST /authenticate/`(form 账号+密码,头 `X-CSRFTOKEN`)→ 抓 `sessionid` + 轮换后的 `csrftoken`,按环境落盘。
- 命令执行前若本地无会话,自动登录(`ensureSession`)。
- 受保护请求被重定向到登录页(会话失效)→ 自动用配置账密重登一次并重试(`sendRaw` + `isLoginPage`)。
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

## 5. 工单提交(workflow sqlcheck / submit / groups / content / execute / wait / cancel)

> 端点(与浏览器端页面/表单提交等价,均为平台既有入口):

| 子命令 | 端点 | 说明 |
|---|---|---|
| `workflow groups` | `GET /submitsql/`(解析 `select#group_name` 的 `<option ... group-id="N">`) | 提交用的组清单(id→名称),取自提交页的组下拉框。id 与名称以 `workflow groups` 实际输出为准 |
| `workflow sqlcheck` | `POST /api/v1/workflow/sqlcheck/`(JSON: `{full_sql, instance_id, db_name}`) | 服务端审核,**不建工单**。看 `error_count` / `is_critical` / 每语句 `errlevel` |
| `workflow submit` | `POST /api/v1/workflow/`(JSON: `{workflow:{workflow_name, group_id, instance, db_name, is_backup, run_date_start, run_date_end}, sql_content}`) | 创建工单,状态 `workflow_manreviewing`。**只是建单,不执行 SQL**;执行仍走平台审批/执行流 |
| `workflow list` | `POST /sqlworkflow_list/`(form) | 工单列表。`--instance`/`--group` 接受**实例名/组名**(自动解析 id)或数字;`--status` 用英文 key(如 `workflow_finish`) |
| `workflow content` | `GET /sqlworkflow/detail_content/?workflow_id=N` | 工单里审核/执行过的语句明细(`rows[].stage`: CHECKED/EXECUTED) |
| `workflow execute` | `POST /execute/`(页面表单:`mode=auto\|manual`, `workflow_id`) | 等价于详情页的「立即执行」:执行已具备执行条件的工单,能否执行取决于工单状态与账号权限。页面表单端点,POST 成功 302 回 detail |
| `workflow cancel` | `POST /cancel/`(页面表单:`workflow_id`, `cancel_remark`) | 终止待审/待执行工单(人工终止,状态 `workflow_abort`,终态不可复活,只能重新提交) |

```powershell
mycastle archery workflow groups --env test
mycastle archery workflow sqlcheck --instance "<instance|id>" --db db_sample --sql-file sync.sql --env test
mycastle archery workflow submit --instance "<instance|id>" --db db_sample --group-id <group-id> --name "<ticket-name>" `
  --sql-file sync.sql [--backup] [--yes] --env test
mycastle archery workflow content --workflow-id <id> --env test
```

- **submit 默认 dry-run**:先跑 sqlcheck,返回 `{submitted:false, dryRun:true, check}`;加 `--yes` 才真正建单。sqlcheck 有 error/critical 时直接拒绝提交。
- **`--instance` 支持实例名或数字 id**,按**三级解析**:数字直通 → 查询视图(`can_execute` 退 `can_read`)→ `--group-id` 对应组的 `can_write` 视图。查询视角与提交视角是**两套清单,id 可能不同**(提交用的主库常不出现在查询视角),提单这类实例时必须带 `--group-id`。
- **实例 id 反查**(id 无处可查时):`workflow list --instance <猜测id> --limit 3` 看返回 rows 的 `instance__instance_name` 命中哪个实例名。⚠️ 不能用 `query` 验证 id——实例不在查询视角时报「你所在组未关联该实例」(权限错,非 id 不存在)。`sqlcheck` 无 `--group-id` 解析,主库实例直接传数字 id 或先 `instances --group` 查。
- **`instances --group <组名|id>`** 出提交视角实例清单(`POST /group/instances/`,`group_name`+`tag_code`,默认 `can_write`=可提单,即提交页实例下拉同源);`instances`(无 `--group`)出查询视角(`GET /group/user_all_instances/`)。
- **`workflow wait` / `execute --wait` 轮询到终态**:主信号 = `detail_content` 单请求(`rows` 由 CHECKED→EXECUTED 渐进翻转,全 EXECUTED=完成,空=未开始);列表状态只在首拍与每 5 拍查一次,兜底捕捉 abort/exception(此时内容会冻结在混合态)。单拍 404/抖动容忍(`lastError` 记录后续轮不中断);终态判定 = `workflow_finish` / `workflow_abort` / 状态含 error/exception/failed。已终态首拍即返回,可重入。
- **`workflow get`**:平台无按 id 的 REST 端点(`/api/v1/workflow/<id>/` 404、`?id=` 无效),按 `sqlworkflow_list` 从新到旧翻页找 id。
- **工单 SQL 里可以带注释,但放行首独立行最稳**:`--`/`#` 整行注释合法且会被保留——strip 逻辑把注释附着在所属语句前提交(被剥离的事务语句,其前导注释会传递给下一条保留语句,文件头注释不丢;含分号的注释也不会切碎语句)。分号后同行的行尾注释由客户端归一化为独立行再附着;prd 实证旧版会把它与下一条语句粘成一行(`-- noteUPDATE …`)整条吞掉,sqlcheck 仍 0 error 0 warning,只有 dry-run `affected_rows` 合计异常才暴露。平台审核对注释无告警。
- **提交前核对语句数**:`workflow content` 的 rows 数应 = 语句数 + 1(use db)且 affected_rows 合计与预期一致;不符即有语句被吞/被剥,回查 SQL 文件。
- **工单不接受事务控制语句**:`SET NAMES` / `BEGIN` / `START TRANSACTION` / `COMMIT` / `ROLLBACK` 会报 `Not supported statement type`(Archery 自管事务与字符集)。sqlcheck/submit 默认**自动剥离**这些语句(`--raw` 关闭剥离);事务版 SQL 文件可直接喂给 `--sql-file`。
- 剥离前先按行剔除 `--`/`#` 注释再按顶层分号切分(引号感知)——注释里的半角分号(如中文注释"…;说明。")会把语句切碎。
- 生成喂给工单的 SQL 必须每条语句以 `;` 结尾:末条缺分号时,下一条(如 COMMIT)会被并进来连带报错。
- `is_backup` 对应提交体的 `"is_backup":false`;`run_date_start/end` 空串=立即。
- **workflow_name 字符限制**:含 `/` 会 400 且响应 body 为空(全角括号疑似同),无错误详情极难排查;用中文/空格/连字符。
- **execute/cancel 结果判定**:页面表单端点成功时 302 → `/detail/N/`(探针 `redirectedToDetail:true`);留在原端点(200)是视图 render 的错误页(如工单状态不可执行)。最终以 `workflow content`(stage=EXECUTED)/ `workflow list`(status)为准。注意 `workflow_abort` 是人工终止的终态。
- **HTML 误判防护(两处)**:`/submitsql/` 等表单页与 execute 成功 302 回的 detail 页都含 `csrfmiddlewaretoken`,会被 `isLoginPage` 误判成会话过期并触发无谓重登;页面/表单请求分别走 `client.page()` / `postFormPage()`(manual redirect,仅 302→`/login/` 才重登),不走该判定。
- 经典表单端点(`/execute/` `/cancel/`)与浏览器提交表单一致:`X-CSRFTOKEN` 头(值=cookie csrftoken)与表单里的 `csrfmiddlewaretoken` 字段均由 Django 双提交校验接受。

## 6. 注意

- **读路径只读,提交路径只建单**:`query` 仅跑用户给的 SQL(服务端强制只 SELECT);`workflow submit` 只创建待审工单,不执行 SQL。审核/执行工单仍需在平台 UI 走审批流(execute 子命令可代执行已过审工单,见 §5)。
- **`instances` 是"可访问视图"非全量清单,且查询/提交是两套视图**:`GET /group/user_all_instances/?tag_codes[]=can_read` 返回**当前账号在其分组权限内能访问**的实例(SQL 查询页下拉框同源);提交页实例下拉走 `POST /group/instances/`(组视角,`can_write`=可提单)。两套清单 id 可能不同,以 `instances --group` 的提交视角为准提单。要拿 `--instance` 的实例名,先跑 `instances`(或 `instances --group`)。
- **明文 HTTP**:内网走 `http://` 明文链路有泄露风险,留意是否有 HTTPS 入口。
- **CSRF 轮换**:登录后若服务端轮换 `csrftoken`,客户端用新值落盘,否则后续 POST 失效。
- **实例名编码**:实例名可能含中文等非 ASCII 字符,URL 与 form 编码需一致(`URLSearchParams` 统一处理),避免编码差异导致 404。
- **响应形状**:工单状态枚举、`/query/` 结果行列结构等以实跑为准。
- **请求头**:带 `X-Requested-With` 与 `Referer`,贴近浏览器 ajax,避免被网关拦截。
- **超时与大表聚合**:单请求 HTTP 超时默认 30000ms,`--timeout <ms>` 可放宽(如 `--timeout 120000`)。超大表按时间字段过滤容易超时;可改用**主键范围**扫描(`WHERE id >= <cutoff>`,`MAX(id)` 秒回,先用单点 `SELECT id,create_time WHERE id=<试探值>` 校准天数↔id 距离),聚合走 PK 范围即可落在超时内。
- **Inception 换行折叠误报**:`FROM DUAL` 后接换行再写 `WHERE` 会被折叠成 `DUALWHERE` 误报语法错;同一行书写即消。
