# YApi CLI(多环境,会话/项目 token 双模式)

> 代码:`src/yapi.ts` + `src/lib/yapi-client.ts` + `src/lib/yapi-config.ts` + `src/lib/yapi-session.ts`

`mycastle yapi` 是对 YApi 的脚本化封装:项目/分类/接口浏览、搜索、快照导出、webUrl 拼接,以及**受控写命令**(建分类 / 迁分类 / 建接口 / 改接口,默认 dry-run,`--apply` 才落库)。基于 Node 20+ 全局 `fetch`,**零额外依赖**,Linux / macOS / Windows 通用。

## 1. 两种鉴权模式

| 模式 | 配置 | 特点 |
|---|---|---|
| **session** | `username` + `password`(YApi 账号) | `POST /api/user/login` → `_yapi_token`(JWT,7 天)+ `_yapi_uid`,cookie 按环境落盘复用;一次登录覆盖账号可见的全部项目;过期自动重登 |
| **token** | `tokens: { "<pid>": "<token>" }`(项目级 openapi token) | 无状态,query 参数直传;只覆盖配了 token 的项目 |

- 同一 env 可两者都配:显式 `--project <pid>` 且配了该项目的 token 时优先 token,否则走 session。
- 自动重登**只**认 `errcode=40011 且 errmsg 含「请登录」`——YApi 服务器内部异常同样返回 40011(errmsg 为「服务器出错…」),不能据此重登。
- 实例部署版本 **1.9.x 实测**:登录态同端点双通道、`/api/project/token` 反查均按上述行为工作(源码核对基于 YMFE/yapi 仓库)。

## 2. 配置 `.myws/yapi.config.json`(gitignored)

真实 URL / 账号 / token**只**在此文件;schema 与占位示例只在本节,**不建 `.example`**。

```jsonc
{
  "default": "main",
  "envs": {
    "main": {
      "url": "https://yapi.example.com",
      "username": "you@example.com",
      "password": "********"
      // 可选:项目级 token(与 session 并存)
      // "tokens": { "<pid>": "********" }
    }
  }
}
```

- `default`:`--env` 缺省时取它,否则首个 env;`--env all` / `--env a,b` 多环境。
- 会话 cookie 按环境存 `<configDir>/yapi-session-<env>.json`(Windows 为 `%LOCALAPPDATA%\mycastle`)。

> ⚠️ **不要直接读取 `.myws/yapi.config.json` 来枚举环境**——文件内容(明文密码/token)会进入 agent 上下文并发往模型服务端。枚举一律用 `mycastle yapi envs`:输出 url(内嵌凭证已剥除)+ 鉴权模式 + 用户名,永不输出密码/token。

## 3. 用法

```powershell
mycastle yapi envs                      # 已配置环境(url + 鉴权模式,无密钥)
mycastle yapi login                     # 登录并持久化 cookie(仅 session 模式)
mycastle yapi status                    # 连通性/鉴权探针(session 或 token)
mycastle yapi projects                  # 账号可见的全部分组+项目(仅 session 模式)
mycastle yapi project <pid>             # 项目基本信息
mycastle yapi cats <pid>                # 分类 + 各分类接口列表(默认摘要投影)
mycastle yapi cats <pid> --full         # 同上,保留 list_menu 原始全量(含 res_body,很大)
mycastle yapi interfaces <pid>          # 扁平接口列表(自动翻页拉满)
mycastle yapi cat-ifaces <pid> --cat <catid>   # 某分类下的接口(自动翻页)
mycastle yapi interface <id>            # 单接口全量详情(session 模式无需 --project)
mycastle yapi token <pid>               # 反查项目 openapi token(仅 session 模式;输出即密钥,勿外传)
mycastle yapi search <pid> --q <keyword> [--status done]   # 按 title/path 关键字过滤
mycastle yapi url <pid> [ifaceId] [--cat <catid>]          # 拼项目/分类/单接口访问 URL
mycastle yapi cats <pid> --url          # 分类/接口列表每条带 webUrl(可直接点开)
mycastle yapi export <pid>              # 项目全量快照落 configDir/yapi/snapshots
mycastle yapi logout                    # 服务端登出并清本地 cookie

# 受控写命令(默认只打印计划;加 --apply 才真正写)
mycastle yapi cat-add <pid> --name <name> [--desc <text>] [--apply]     # 建分类,回显 catid + webUrl
mycastle yapi iface-move <id> --cat <catid> [--message <m>] [--apply]   # 迁分类,复拉自检
mycastle yapi iface-add <pid> --file <spec.json> [--apply]              # 批量建接口(单对象或数组)
mycastle yapi iface-up <id> --file <patch.json> [--apply]               # 任意字段局部 patch
```

### iface-add 的 spec 文件

**一个对象或对象数组**,必填 `title` / `path`(以 `/` 开头)/ `method` / `catid`;可选 `desc`(支持 HTML)、`req_headers`、`req_query`、`req_params`、`req_body_type`、`req_body_other`(JSON Schema 字符串)、`req_body_is_json_schema`、`res_body_type`、`res_body`、`res_body_is_json_schema`、`status`、`tag`、`markdown`。默认 `status=done`、`req_body_type=json`、`res_body_type=json`;给了 body 自动置 schema 标记。落库前校验 `catid` 属于该项目(避免建到别的项目的分类下)。

### iface-up 的 patch 文件

**一个对象**,只写要改的字段(YApi `up` 是局部更新):`title`/`path`/`method`/`catid`/`status`/`desc`/`markdown`/`tag`/`api_opened`/`req_headers`/`req_query`/`req_params`/`req_body_type`/`req_body_form`/`req_body_other`/`req_body_is_json_schema`/`res_body_type`/`res_body`/`res_body_is_json_schema`(拒绝 `id`,白名单外字段报错)。给 `req_body_other`/`res_body` 会自动补 `*_is_json_schema=true` 与 `*_body_type=json`;改 `catid` 先校验分类属于该项目。dry-run 输出 `changed`(与现值不同的字段)和 `reqSchemaDiff`/`resSchemaDiff`(root / data / data.items 的属性增删);落库后输出 `appliedMatches`。

### 其他说明

- **访问 URL 规则**(1.9.x 前端路由核实,三级均可直达):项目 `/project/<pid>/interface/api`;分类 `/project/<pid>/interface/api/cat_<catid>`;单接口 `/project/<pid>/interface/api/<interfaceId>`。`cats`/`interfaces`/`cat-ifaces`/`search` 加 `--url` 即在每条上输出 `webUrl`;`interface <id>` 详情自动带 `webUrl`(session 模式未指定项目时除外)。
- 项目 id 的两种给法:项目级命令直接写位置参数 `<pid>`;`interface <id>` 用 `--project <pid>`(session 模式下可省略,token 模式必须能定位到项目)。只配了一个 token 项目且无 session 时,`<pid>`/`--project` 可省略。
- 默认 pretty JSON;`--compact` 单行;`--env all` / `--env a,b` 多环境,输出按环境名聚合。
- 快照文件:`<configDir>/yapi/snapshots/<env>/<pid>-<时间戳>.json`(路径打到 stderr,JSON 打到 stdout)。

## 4. 错误码与自动重登

- 包络统一 `{errcode, errmsg, data}`,HTTP 恒 200,**业务错误看 `errcode`**。
- `errcode=40011, errmsg 含 "请登录"` = 未登录/token 无效,session 模式自动重登一次;重试后仍失败即抛错。
- 登录失败(用户不存在/密码错)直接抛 `YapiApiError`,errmsg 保留服务端原文。
- 错误对象带 `errcode` / `errmsg` / `status` / `url` / `env`(传输/超时 `status` 为 `0`)。

## 5. 在脚本里复用客户端

```ts
import { YapiClient } from "./lib/yapi-client.js";
import { loadYapiConfig, resolveAuth } from "./lib/yapi-config.js";

const cfg = loadYapiConfig();
const envCfg = cfg.envs["main"]!;
const c = new YapiClient({
  env: "main",
  baseUrl: envCfg.url,
  auth: resolveAuth(envCfg), // 凭据不出配置文件,勿硬编码
});
await c.ensureSession();
const list = await c.interfaces();      // 需配了 projectId 的 auth 或改走 projects()
const detail = await c.getInterface(1234);
```

出错抛 `YapiApiError`,带 `errcode` / `errmsg` / `status` / `url` / `env`。

## 6. 注意(实测)

- **写操作面**:`cat-add`(`POST /api/interface/add_cat`)、`iface-move`(`POST /api/interface/up`,只带 `catid`)、`iface-add`(`POST /api/interface/add`,按 spec 批量建接口)、`iface-up`(`POST /api/interface/up`,按 patch 局部改契约)。YApi 的 `up` 是**局部更新**(源码 `Object.assign({up_time}, params)`,只写传入字段),所以迁分类不会动标题/路径/schema;`iface-move` 复拉并输出 `otherFieldsIntact` 自检,`iface-up` 输出 `appliedMatches`(按字段 JSON 比对;`req_query`/`req_params` 会被服务端补 `_id`,此时为 false 属正常)。四个命令都默认 dry-run,`--apply` 才落库。
- **尚未实现**:数据导入(`open/import_data`)、删分类/删接口。
- **`projects` 的枚举口径**:`GET /api/group/list` + 逐分组 `GET /api/project/list?group_id=`(与网页左侧栏一致);私有分组里非成员项目会被服务端过滤,结果即「账号可见集」。
- **`list_menu`/`--full` 很重**:list_menu 每个接口带全量 `res_body`;默认 `cats` 已做摘要投影(`_id/title/path/method/status/时间`),全量细节用 `interface <id>` 或 `export` 取。
- **翻页**:`/api/interface/list` 与 `list_cat` 按官方文档建议用 `limit=1000` 逐页拉满,返回不足一页即停;两种 `data` 形态(数组/`{list}`)客户端已归一化。
- **JWT 有效期 7 天**:登录态 cookie 落盘复用,过期后首个 40011(请登录)自动重登;`logout` 服务端登出并清盘。
- **明文 HTTP**:内网 `http://` 链路,密码/token/cookie 均明文过网,留意网关/代理日志泄露面。
- **写接口/文档本身**:官方开放 API 共 11 个端点;session 通道端点集与网页 UI 相同(如 `/api/project/list`、`/api/group/list` 未在开放 API 文档中,但同一鉴权体系下可用)。
