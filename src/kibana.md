# 通过 Kibana REST API 脚本化访问(只读,多环境)

> 代码:`src/kibana.ts` + `src/lib/kibana-client.ts` + `src/lib/kibana-config.ts`

`mycastle kibana` 是一个对 Kibana REST API 的只读封装,用于脚本化查询 Spaces、Data Views(索引模式)、**按空间检索日志**等。基于 Node 20+ 全局 `fetch`,**零额外依赖**,Linux / macOS / Windows 通用。支持多环境并存。

> API 文档:<https://www.elastic.co/docs/api/doc/kibana/>

## 1. 配置 `.myws/kibana.config.json`(gitignored)

真实 URL / 密钥**只**在此文件;schema 与占位示例只在本节,**不建 `.example`**。

```jsonc
{
  "default": "local",                     // --env 缺省时取它,否则首个 env
  "envs": {
    // 匿名访问:auth 填 "none"(凭据字段留空即可)
    "local": {
      "url": "http://kibana.example.com",
      "basePath": "",                    // 配了 server.basePath 才填,如 "/kibana"
      "timeoutMs": 30000,
      "auth": "none"
    },
    // Basic 认证实例
    "sec": {
      "url": "http://kibana-sec.example.com",
      "auth": "basic",
      "username": "elastic",
      "password": "********"
    },
    // API Key 认证实例(推荐):填 "id:api_key"(自动 base64)或已编码 token
    "cloud": {
      "url": "https://kibana-cloud.example.com",
      "auth": "apiKey",
      "apiKey": "<id>:<api_key>"
    }
  }
}
```

- `envs`:环境名 → `{ url, auth?, ...凭据 }`,环境名任意(不限于 dev/test/prd);`auth` 三选一:`"none"` / `"apiKey"` / `"basic"`。
- `auth` **可省略**,按字段自动推断:有 `apiKey` → apiKey;有 `username`/`password` → basic;否则 none。
- 每环境可选 `basePath`(默认空)、`timeoutMs`(默认 `30000`)。
- 认证凭据**只**从配置文件(或环境变量)读,绝不进命令行 flags。

### 目标选择优先级

1. `--url <u>` flag(临时指向,绕过配置文件)
2. `.myws/kibana.config.json`(默认取 `default`,或 `--env <name|all|a,b>` 选)
3. 环境变量快速模式:`KIBANA_URL`(+ `KIBANA_API_KEY` 或 `KIBANA_USERNAME`/`KIBANA_PASSWORD`)

> env 快速模式适合临时一次性探测;持久使用建议写进配置文件(认证随实例走,不用每次设 env)。

> 先不知道要不要认证?把实例 `auth` 填 `"none"`,跑一次 `status`(见下):通就是免认证可用,`401` 就把 `auth` 改成 `"basic"` 或 `"apiKey"` 补凭据。

> ⚠️ **不要直接读取 `.myws/kibana.config.json` 来枚举环境**——文件内容(含 API Key/密码)会进入 agent 上下文并发往模型服务端。枚举用 `mycastle kibana envs`:输出每个环境的 name/url/basePath/auth 方式(`apiKey`/`basic`/`none`),永不输出 key、用户名或密码。

## 2. 用法

```powershell
mycastle kibana envs                                              # 列出环境名 + URL + 认证方式(不含 key/密码)
mycastle kibana status                                            # 连通性 / 认证探针(default 环境)
mycastle kibana status --env dev                                  # 指定环境
mycastle kibana spaces list --env dev                             # 列出所有空间
mycastle kibana spaces get my-space --env dev                     # 查单个空间
mycastle kibana data-views list --env dev                         # 列出所有 data view(索引模式)
mycastle kibana data-views get <id> --env dev                     # 查单个 data view
mycastle kibana get "/api/saved_objects/_find?type=dashboard" --env dev  # 任意只读端点(逃生舱)
```

- **配置模式输出按环境名聚合**:`{"<env>": <结果>}`;某环境失败置 `{"<env>": {"error": "..."}}`,不中断其余。`--env all` / `--env dev,prd` 一次跑多个。
- 默认输出 pretty JSON;`--compact` 单行。`--config <path>` 覆盖配置路径。
- 非密钥覆盖项:`--url`(绕过配置)、`--base-path`、`--timeout`。
- 路径含 `?`/`&` 时务必**加引号**(PowerShell/bash 都会把它们当特殊字符)。

### env 快速模式(不建配置文件时)

PowerShell:

```powershell
$env:KIBANA_URL = "http://kibana.example.com"
$env:KIBANA_API_KEY = "<id>:<api_key>"  # 或 KIBANA_USERNAME/KIBANA_PASSWORD
mycastle kibana status        # 此模式输出为单结果(不带环境名包裹)
```

bash:

```bash
export KIBANA_URL=http://kibana.example.com
export KIBANA_API_KEY="<id>:<api_key>"
```

## 3. 按空间检索日志(search)

等价于 Kibana Discover 的检索:走 Kibana 对 Elasticsearch 的透传端点 `POST /s/<space>/elasticsearch/<index>/_search`(只读,返回结构化 JSON)。

```powershell
# 指定空间 + 索引模式 + 最近 24h + 多个短语过滤(相当于 Discover 里带引号的搜索词)
mycastle kibana search --space my-space --index "my-service*" `
  --phrase "request failed" --phrase "timeout" --phrase "ok=false"

# 绝对时间范围 + 30m 直方图 + 取 500 条
mycastle kibana search --space my-space --index "my-service*" `
  --from 2026-09-21T00:00:00+08:00 --to 2026-09-21T12:00:00+08:00 `
  --histogram 30m --size 500

# 排除词 + 只取部分字段 + 输出 ES 原始响应
mycastle kibana search --space my-space --index "my-service*" --last 1h `
  --exclude DEBUG --source-fields "@timestamp,message" --raw
```

bash 下把行尾反引号 `` ` `` 换成 `\` 即可,其余一致。

行为说明:

| 项 | 规则 |
|---|---|
| 短语过滤 | `--phrase` / `--exclude` 可重复;内部为 `multi_match {type:"phrase", lenient:true}`(中文词、数字+字母混合词都安全) |
| 时间范围 | `--from`/`--to`(ISO 8601,可带时区)与 `--last <n>s\|m\|h\|d` 可组合(`--from X --last 2h` = X 起 2 小时);都不给时**默认最近 24h** |
| 时间字段 | 默认 `@timestamp`,`--ts-field` 可改;range 放 `bool.must`、短语放 `bool.filter`,与 Kibana UI 生成的查询一致 |
| 排序/条数 | 按时间字段倒序(`--order asc\|desc`),`--size` 默认 100 |
| 输出 | 默认裁剪为 `{space, index, took_ms, total, returned, hits:[{_index,_id,_source}]}`;`--raw` 输出 ES 原始响应 |
| 直方图 | `--histogram 30m` 时附带 `aggregations.histogram`(桶,时区 `--tz`,默认 Asia/Shanghai) |

> 中文参数经 PowerShell 命令行传入时,注意会话编码(Windows 非交互 shell 默认 GB2312,需先设 UTF-8;`mycastle env` 可自查)。

在脚本里复用:`client.search({ space: "my-space", index: "my-service*", body })`,`body` 为任意 Elasticsearch search body(`query`/`sort`/`aggs`/`size`...),返回原始 ES 响应。

## 4. 在脚本里复用客户端

```ts
import { KibanaClient } from "./lib/kibana-client.js";
import { loadKibanaConfig, toClientOptions } from "./lib/kibana-config.js";

const k = KibanaClient.fromEnv(); // 从 env 读取(快速模式)
// 或从配置文件取某环境(凭据不出配置文件):
const cfg = loadKibanaConfig();
const k2 = new KibanaClient(toClientOptions(cfg.envs["inner"]!));
const spaces = await k2.spaces.list();
const raw = await k2.get("/api/saved_objects/_find?type=index-pattern");
```

出错会抛 `KibanaApiError`,带 `status` / `body` / `url`(传输/超时错误 `status` 为 `0`)。

## 5. 注意

- **"Index Management" 的两种含义**:管理 Kibana 的**索引模式(Data Views)** 用本工具;管理**真实索引 / index template / data stream** 是 Elasticsearch API(需指向 ES host),不在本工具范围内。
- **明文 HTTP**:API Key 走 `http://` 明文链路有泄露风险,留意内网是否有 HTTPS 入口。
- **SSO 部署**:若实例强制 SSO 且禁用 API Key/basic,免认证也会 `401`,需走 SSO token(本工具暂不支持)。
- 当前为**只读**;创建/更新/删除(空间、data view)等写操作后续再加。
