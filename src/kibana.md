# 通过 Kibana REST API 脚本化访问(只读,多环境)

> 代码:`kibana.ts` + `lib/kibana-client.ts` + `lib/kibana-config.ts`

本仓库的 `src/kibana.ts` 是一个对 Kibana REST API 的只读封装,用于脚本化查询 Spaces、Data Views(索引模式)等。基于 Node 20+ 全局 `fetch`,**零额外依赖**。支持 dev/test/prd 多环境并存。

> API 文档:<https://www.elastic.co/docs/api/doc/kibana/>

## 1. 配置 `.myws/kibana.config.json`(gitignored)

真实 URL / API Key / 账号密码**只**在此文件;schema 与占位示例只在本节,**不建 `.example`**。

```jsonc
{
  "default": "dev",
  "envs": {
    "dev": {
      "url": "http://kibana.dev.example.com",
      "apiKey": "VuaCfGcBCdbkQmQEeFVnaoxxxx:xxxxxxxxxxxx"
    },
    "prd": {
      "url": "https://kibana.prd.example.com",
      "basePath": "/kibana",
      "timeoutMs": 60000,
      "username": "********",
      "password": "********"
    }
    // 匿名访问:只填 url,不设 apiKey/username/password
  }
}
```

- `envs`:环境名 → `{ url, basePath?, timeoutMs?, apiKey?, username?, password? }`,环境名任意(不限于 dev/test/prd)。
- `default`:`--env` 缺省时取它,否则首个 env。
- `url`(必填):Kibana 基址。
- `basePath`(可选):配置了 `server.basePath` 时填,如 `/kibana`,默认空。
- `timeoutMs`(可选):请求超时(毫秒),默认 `30000`。
- 认证(三选一,密钥**只**从配置文件读,绝不进命令行):
  - 免认证:都不设 → 匿名访问,仅当实例允许时可用。
  - API Key(推荐):`apiKey` — 可填 `id:api_key`(自动 base64),或已编码好的 token。
  - Basic:`username` + `password`。

> 先不知道要不要认证?只填 `url`,跑一次 `status`(见下):通就是免认证可用,`401` 就是必须带凭据。

## 2. 用法

```powershell
mycastle kibana envs                                              # 列出已配置的环境名(不泄密)
mycastle kibana status --env dev                                  # 连通性 / 认证探针
mycastle kibana spaces list --env dev                             # 列出所有空间
mycastle kibana spaces get marketing --env dev                    # 查单个空间
mycastle kibana data-views list --env dev                         # 列出所有 data view(索引模式)
mycastle kibana data-views get <id> --env dev                     # 查单个 data view
mycastle kibana get "/api/saved_objects/_find?type=dashboard" --env dev  # 任意只读端点(逃生舱)
```

多环境:`--env all` 或 `--env dev,prd` 一次跑多个,输出按键聚合 `{"dev":{...},"prd":{...}}`,单环境失败不中断其余(置 `{"error":"..."}`)。

- 默认 pretty JSON;`--compact` 单行。`--config <path>` 覆盖配置路径。
- 路径含 `?`/`&` 时务必**加引号**(PowerShell/bash 都会把它们当特殊字符)。

## 3. 在脚本里复用客户端

```ts
import { KibanaClient, resolveAuth } from "./lib/kibana-client.js";

const k = new KibanaClient({
  baseUrl: "http://kibana.dev.example.com",
  basePath: "",
  auth: resolveAuth({ apiKey: "id:api_key" }), // 或 { username, password },或省略 = 匿名
  timeoutMs: 30000,
});
const spaces = await k.spaces.list();
const raw = await k.get("/api/saved_objects/_find?type=index-pattern");
```

出错会抛 `KibanaApiError`,带 `status` / `body` / `url`(传输/超时错误 `status` 为 `0`)。

## 4. 注意

- **"Index Management" 的两种含义**:管理 Kibana 的**索引模式(Data Views)** 用本工具;管理**真实索引 / index template / data stream** 是 Elasticsearch API(需指向 ES host),不在本工具范围内。
- **明文 HTTP**:API Key 走 `http://` 明文链路有泄露风险,留意内网是否有 HTTPS 入口。
- **SSO 部署**:若实例强制 SSO 且禁用 API Key/basic,免认证也会 `401`,需走 SSO token(本工具暂不支持)。
- 当前为**只读**;创建/更新/删除(空间、data view)等写操作后续再加。
