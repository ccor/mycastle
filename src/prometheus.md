# 通过 Prometheus HTTP API 脚本化访问(只读,多实例)

> 代码:`src/prometheus.ts` + `src/lib/prometheus-client.ts` + `src/lib/prometheus-config.ts`

`mycastle prometheus` 是对 Prometheus HTTP API 的只读封装:瞬时/区间 PromQL 查询、series/label 浏览、抓取目标查看,支持多实例并存与三种认证。基于 Node 20+ 全局 `fetch`,**零额外依赖**,Linux / macOS / Windows 通用。

> API 文档:<https://prometheus.io/docs/prometheus/latest/querying/api/>
> 目标实例(占位):`http://prometheus.example.com`

## 1. 配置 `.myws/prometheus.config.json`(gitignored,多实例)

真实 URL / 密钥**只**在此文件;schema 与占位示例只在本节,**不建 `.example`**。

```jsonc
{
  "default": "inner",                    // --env 缺省时取它,否则首个 env
  "envs": {
    // 匿名访问:auth 填 "none"(凭据字段留空即可)
    "inner": {
      "url": "http://prometheus.example.com",
      "basePath": "",                    // 反代加了路径前缀才填,如 "/prometheus"
      "timeoutMs": 30000,
      "auth": "none"
    },
    // Basic 认证实例
    "sec": {
      "url": "http://prometheus-sec.example.com",
      "auth": "basic",
      "username": "prom",
      "password": "********"
    },
    // Bearer token 实例(auth "apiKey" -> Authorization: Bearer <token>,多用于反代鉴权)
    "proxy": {
      "url": "https://prometheus-proxy.example.com",
      "auth": "apiKey",
      "apiKey": "<bearer-token>"
    }
  }
}
```

- `envs`:实例名 → `{ url, auth?, ...凭据 }`,实例名任意;`auth` 三选一:`"none"` / `"basic"` / `"apiKey"`(Bearer)。
- `auth` **可省略**,按字段自动推断:有 `apiKey` → apiKey;有 `username`/`password` → basic;否则 none。
- 每实例可选 `basePath`、`timeoutMs`(默认 30000)。

### 目标选择优先级

1. `--url <u>` flag(临时指向,绕过配置文件)
2. `.myws/prometheus.config.json`(默认取 `default`,或 `--env <name|all|a,b>` 选)
3. 环境变量快速模式:`PROMETHEUS_URL`(+ `PROMETHEUS_API_KEY` 或 `PROMETHEUS_USERNAME`/`PROMETHEUS_PASSWORD`)

> ⚠️ **不要直接读取 `.myws/prometheus.config.json` 来枚举实例**——文件内容(含密钥)会进入 agent 上下文并发往模型服务端。枚举一律用 `mycastle prometheus envs`:输出 url/basePath/auth 方式(`apiKey`/`basic`/`none`),永不输出密钥、用户名或密码。

> 先不知道要不要认证?把实例 `auth` 填 `"none"`,跑一次 `status`(见下):通就是免认证可用,`401/403` 就把 `auth` 改成 `"basic"` 或 `"apiKey"` 补凭据。

## 2. 用法

```powershell
mycastle prometheus envs                            # 列出已配置实例(url/auth,不含密钥)
mycastle prometheus status                          # 连通性 / 版本探针(default 实例)
mycastle prometheus status --env inner              # 指定实例

# 瞬时查询(默认当前时刻;time 可给 unix 秒或 ISO 8601)
mycastle prometheus query 'up{job="my-service"}'
mycastle prometheus query 'http_server_requests_seconds_count{app="my-service"}' --compact

# 区间查询(默认最近 1h、step 60s)
mycastle prometheus range 'sum(rate(http_server_requests_seconds_count[5m])) by (app)' --last 3h --step 5m
mycastle prometheus range 'up' --start 2026-10-14T00:00:00+08:00 --end 2026-10-14T12:00:00+08:00 --step 120

# series / label 浏览(定位可查的指标与标签值)
mycastle prometheus series --match 'http_server_requests_seconds_count{app="my-service"}' --last 1h
mycastle prometheus labels --match 'up{job="my-service"}'
mycastle prometheus values app --match 'http_server_requests_seconds_count'
mycastle prometheus values job

# 抓取目标(含 health up/down、lastError;droppedTargets 折叠为计数)
mycastle prometheus targets --compact

# 逃生舱:任意只读端点(rules / alerts / metadata / tsdb ...)
mycastle prometheus get /api/v1/rules
```

- **配置模式输出按实例名聚合**:`{"<env>": <结果>}`;某实例失败置 `{"<env>": {"error": "..."}}`,不中断其余。`--env all` / `--env a,b` 一次跑多个。
- 默认输出 pretty JSON;`--compact` 单行。`--config <path>` 覆盖配置路径。
- 非密钥覆盖项:`--url`(绕过配置)、`--base-path`、`--timeout`;`--raw` 输出完整 API envelope(`{status,data,errorType?,warnings?}`)。
- **PromQL 务必整体加引号**(PowerShell 用单引号最稳,PromQL 字符串字面量支持单/双引号)。

### env 快速模式(不建配置文件时)

```powershell
$env:PROMETHEUS_URL = "http://prometheus.example.com"    # + PROMETHEUS_API_KEY 或 USERNAME/PASSWORD 可选
mycastle prometheus status      # 此模式输出为单结果(不带实例名包裹)
```

## 3. 查询行为说明

| 项 | 规则 |
|---|---|
| 时间参数 | `--time`/`--start`/`--end` 接受 **unix 秒**(如 `1791979264.677`)或 **ISO 8601**(可带时区);`--last <n>[s\|m\|h\|d]` 裸数字按秒 |
| 窗口解析 | `start+end` → 原样;`start+last` → `end=start+last`;`end+last` → `start=end-last`;只 `start` → `end=now`;都不给 → 最近 1h |
| step | `--step` 默认 `60`;接秒数(`"120"`)或时长(`"2m"`),直接传给 API |
| 输出(query/range) | 裁剪为 `{query, time?, start?, end?, step?, resultType, result}`;`result` 为 vector(`[{metric, value:[ts,"val"]}]`)或 matrix(`values`)原样;`warnings` 有则带上;`--raw` 看全量 |
| 输出(targets) | `{activeTargets: [...], droppedTargetsCount: n}`(dropped 明细要全量时走 `get /api/v1/targets` 或 `--raw`) |
| 错误 | PromQL 语法错 → API `422` + `errorType:"bad_data"`(带 `error` 文案);参数错 → `400`;查询超时 → `503`;网络/超时 → `status 0` |

在脚本里复用客户端:

```ts
import { PrometheusClient } from "./lib/prometheus-client.js";
import { loadPrometheusConfig, toClientOptions } from "./lib/prometheus-config.js";

const cfg = loadPrometheusConfig();
const p = new PrometheusClient(toClientOptions(cfg.envs["inner"]!));
const res = await p.query('up{job="my-service"}'); // res.data.result = [{metric, value}]
```

出错抛 `PrometheusApiError`,带 `status` / `body`(完整 envelope)/ `url`(传输/超时错误 `status` 为 `0`)。

## 4. 注意

- **只读**:全部为 GET;远程写 / 管理 API 一律不做。
- **`buildinfo` 兼容性**:`/api/v1/status/buildinfo` 需 Prometheus ≥ 2.x(较老实例实测可用);若 404,用 `get /api/v1/labels` 当探针。
- **大结果**:range 查询点数 = 窗口/step,`--last 7d --step 60s` 会拉 ~1 万点;宽窗口记得放大 `--step`。
- **明文 HTTP**:Bearer/basic 走 `http://` 明文链路有泄露风险,留意内网是否有 HTTPS 入口。
