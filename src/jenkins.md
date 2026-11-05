# 通过 Jenkins Remote Access API 脚本化访问(多实例,写操作 opt-in)

> 代码:`src/jenkins.ts` + `src/lib/jenkins-client.ts` + `src/lib/jenkins-config.ts`

`mycastle jenkins` 是对 Jenkins Remote Access API 的封装:实例状态、job/构建/日志/队列/节点查询,以及默认 dry-run 的构建触发与终止(需 `--yes`)。基于 Node 20+ 全局 `fetch`,**零额外依赖**,Linux / macOS / Windows 通用。

> API 文档:<https://www.jenkins.io/doc/book/using/remote-access-api/>
> 目标实例(占位):`http://jenkins.example.com`

## 1. 配置 `.myws/jenkins.config.json`(gitignored,多实例)

真实 URL / 凭证**只**在此文件;schema 与占位示例只在本节,**不建 `.example`**。

```jsonc
{
  "default": "dev",                      // --env 缺省时取它,否则首个 env
  "envs": {
    "dev": {
      "url": "http://jenkins.example.com",
      "basePath": "/jenkins",            // 反代 context path;根路径部署则留空或省略
      "timeoutMs": 30000,
      "username": "my-user",
      "apiToken": "<api-token>"          // <jenkins>/me/security/ 里生成,非登录密码
    },
    "prod": {
      "url": "http://jenkins-prod.example.com",
      "username": "********",
      "apiToken": "********"
    }
  }
}
```

- `envs`:实例名 → `{ url, basePath?, username?, apiToken?, timeoutMs? }`,实例名任意。
- `username` + `apiToken` 必须**成对**出现(API Token + Basic Auth);都省略 = 匿名(多数实例匿名无读权限,会 403)。
- 认证为**抢占式 Basic**:Jenkins 未认证直接回 `403`(不做 401 协商),客户端每请求都带凭证即可;API Token 走 Basic 在 Jenkins ≥ 2.96 **免 crumb**,工具无需 CSRF 处理。
- 每实例可选 `basePath`(反代加了 context path 时填)与 `timeoutMs`(默认 30000)。

### 目标选择优先级

1. `--url <u>` flag(临时指向,绕过配置文件)
2. `.myws/jenkins.config.json`(默认取 `default`,或 `--env <name|all|a,b>` 选)
3. 环境变量快速模式:`JENKINS_URL`(+ 可选 `JENKINS_USERNAME`/`JENKINS_API_TOKEN`、`JENKINS_BASE_PATH`)

> ⚠️ **不要直接读取 `.myws/jenkins.config.json` 来枚举实例**——文件内容(含 token)会进入 agent 上下文并发往模型服务端。枚举一律用 `mycastle jenkins envs`:输出 name/url/basePath/auth/username,**永不输出 apiToken**。

> 先跑 `whoami` 验证凭证:返回本人账号名即通过;`403` 说明 token 无效或账号无权限(token 不提权,admin 端点仍会 403)。

## 2. 用法

```powershell
mycastle jenkins envs                                  # 列出实例(url/auth,不含 token)

# 实例概览:版本、quietingDown、job/视图数、按状态计数
mycastle jenkins status
mycastle jenkins whoami                                # 认证自检(先跑这个)

# job 列表:顶层默认;--depth 2 展开一层文件夹;fullName 形如 "folder/sub"
mycastle jenkins jobs
mycastle jenkins jobs --depth 3 --filter my-service
mycastle jenkins jobs --view my-view --status red      # --status 支持 building
mycastle jenkins jobs -n 50 --compact

# job 详情:健康报告、最近构建、参数定义(触发前先看参数)
mycastle jenkins job my-service
mycastle jenkins job team/my-service                   # 文件夹嵌套用 "/"

# 构建历史 / 构建详情(含触发参数)
mycastle jenkins builds my-service -n 10
mycastle jenkins build my-service lastBuild
mycastle jenkins build my-service 42

# 构建日志
mycastle jenkins log my-service                        # 默认 lastBuild,拉到当前末尾
mycastle jenkins log my-service 42 --console           # consoleText 整段(最干净)
mycastle jenkins log my-service --follow               # 跟随构建,直到结束(Ctrl-C 中断)
mycastle jenkins log my-service --max 50000            # 只保留末尾 5 万字符

# 辅助查询
mycastle jenkins queue                                 # 排队中的构建
mycastle jenkins nodes                                 # 节点 + executor
mycastle jenkins views
mycastle jenkins get "/queue/item/123/api/json"        # 逃生舱:任意只读端点

# 写操作:默认 dry-run,加 --yes 才真正执行
mycastle jenkins trigger my-service                    # 无参 job
mycastle jenkins trigger my-service --param BRANCH=main --param DEBUG=false --yes
mycastle jenkins stop my-service 42 --yes              # 终止某次构建
```

- **配置模式输出按实例名聚合**:`{"<env>": <结果>}`;某实例失败置 `{"<env>": {"error": "..."}}`,不中断其余。`--env all` / `--env a,b` 一次跑多个。
- 默认输出 pretty JSON;`--compact` 单行。`--config <path>` 覆盖配置路径。
- 非密钥覆盖项:`--url`(绕过配置)、`--base-path`、`--timeout`;`--raw` 输出未加工的 API JSON(build 命令附带 `raw` 字段)。

### env 快速模式(不建配置文件时)

```powershell
$env:JENKINS_URL = "http://jenkins.example.com"   # + JENKINS_USERNAME / JENKINS_API_TOKEN 可选
mycastle jenkins whoami       # 此模式输出为单结果(不带实例名包裹)
```

## 3. 行为说明

| 项 | 规则 |
|---|---|
| job 命名 | 文件夹嵌套用 `/`:`team/service` → `/job/team/job/service/`;每段自动 URL 编码 |
| 构建号引用 | `<ref>` 接数字或别名:`lastBuild` / `lastCompletedBuild` / `lastSuccessfulBuild` / `lastFailedBuild` / `lastStableBuild` |
| 构建历史 | 用 `allBuilds` 属性(freestyle/workflow/maven 各类型通用,最新在前);**切片语法顺序实测(2.346.1 LTS)只接受 `allBuilds[fields]{0,n}`,官方文档的 `allBuilds{0,n}[fields]` 顺序会 500**,客户端自动先试旧序再试新序,都失败则全量拉取本地截断 |
| 构建保留数 | 列表里的构建数 = 实例实际保留数:配置了构建丢弃策略的 job 可能只剩最新几条(`firstBuild == lastBuild`),不代表总构建号;旧编号直取会 404 |
| 状态色 | `blue`=成功、`red`=失败、`yellow`=UNSTABLE、`grey`/`notbuilt`=未构建、`disabled`、`aborted`;后缀 `_anime` = 构建中(工具输出为 `color` + 布尔 `building`) |
| `tree` 参数 | 全部经 `URLSearchParams` 编码(`[]`→`%5B%5D`):部分前置代理拒绝裸方括号(400);嵌套 tree 由 `--depth` 自动生成,语法错在 Jenkins 侧是无提示 500 |
| 时间戳 | 输出统一转 ISO 8601;`durationMs` 保持毫秒原值 |
| 日志 | 默认 `logText/progressiveText` 增量拉到末尾(`--tail` 等价);`--follow` 构建中每 2s 轮询;`--console` 用 `consoleText` 整段最干净;默认只保留末尾 20 万字符(`--max 0` 不截断) |
| 写操作 | `trigger`/`stop` 默认 dry-run 输出将要发送的内容;`--yes` 才 POST。触发参数化 job 自动走 `buildWithParameters`,成功返回队列项 `queueId`;`stop` 接受 2xx/3xx |
| 错误 | `403` = 凭证缺失/无效或账号无权限(Jenkins 不回 401);`404` = job 名或嵌套路径不对(构建号已被丢弃策略清理也报 404);`500` 常见为 tree 表达式语法错;网络/超时 → `status 0` |

在脚本里复用客户端:

```ts
import { JenkinsClient } from "./lib/jenkins-client.js";
import { loadJenkinsConfig, toClientOptions } from "./lib/jenkins-config.js";

const cfg = loadJenkinsConfig();
const j = new JenkinsClient(toClientOptions(cfg.envs["dev"]!));
const st = await j.instanceStatus();          // st.version / st.json.jobs
const { json } = await j.listJobs({ depth: 2 });
await j.trigger("my-service", { BRANCH: "main" }); // 库层不拦截写操作,调用方自行把关
```

出错抛 `JenkinsApiError`,带 `status` / `body` / `url`(传输/超时错误 `status` 为 `0`;403 的报错文案自带凭证排查提示)。

## 4. 注意

- **写操作边界**:只有 `trigger` / `stop` 两个写端点且默认 dry-run;`pluginManager`、`reload`、`safeRestart`、`quietDown` 等 admin/维护端点一律不做(API token 不提权,通常也 403)。
- **`get` 与敏感配置**:`get` 可读任意端点,但 **`config.xml` 常含明文密码字段**,不要把 job/system 配置页打印进上下文;同理 job 日志可能含敏感参数值,`--max` 控制进入上下文的量。
- **明文 HTTP**:token 走 `http://` 明文链路有泄露风险,留意内网是否有 HTTPS 入口;token 可随时在 `<jenkins>/me/security/` 重置。
- **大结果**:job 数多时 `jobs --depth` 越深响应越大;先用顶层列表 + `--filter` 缩小范围再下钻。
