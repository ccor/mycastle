# 离线扫描 Java 源码的 xxl-job handler 声明(只读,出 JSON)

> 代码:`xxljob-scan.ts`

本仓库的 `src/xxljob-scan.ts` 是一个**离线**源码扫描器:给定 Java 源码根目录,提取 xxl-job 任务入口(handler)声明,输出结构化 JSON。不连 xxl-job 控制台、不读 `.myws/` 配置、不需登录——纯源码分析。与在线的 `xxljob` 工具(查控制台)正交,两者一起喂给 `xxljob-ops` skill 做核对。

## 1. 识别哪些声明

| API | 形式 | 取值 |
|---|---|---|
| 老(`@JobHandler`) | `@JobHandler("x")` / `@JobHandler(value = "x")` | 字面量 `x` |
| 老(`@JobHandler`) | `@JobHandler(value = Cls.CONST)` | 同文件 `static final String CONST = "..."` 解析出的字面量 |
| 新(`@XxlJob`) | `@XxlJob("x")` | 字面量 `x` |

> 为什么要处理常量引用:有些声明写成 `@JobHandler(value = SampleJob.JOB_HANDLER_NAME)`,真实值在同类里的 `public static final String JOB_HANDLER_NAME = "sampleJob"`。只按字符串字面量 grep 会漏它。本工具按字面量 + 同文件常量两种解析,`valueForm` 字段标明取值方式便于复核。

## 2. 用法

```powershell
mycastle xxljob-scan --root <src-root>                    # 默认扫 @JobHandler + @XxlJob,glob **/*.java
mycastle xxljob-scan --root <src-root> --api old          # 只扫老 API
mycastle xxljob-scan --root <src-root> --glob "**/*.java" --compact
```

- `--root`(必填):源码根目录(仓库或模块),递归扫。
- `--api old|new|both`(默认 `both`)。
- `--glob`(默认 `**/*.java`);支持 `**`(跨目录)、`*`(单段)、`?`。
- `--compact`:单行 JSON(默认 pretty)。

## 3. 输出

JSON 数组到 stdout(collector 契约,不做汇总),每条声明一个对象:

```jsonc
[
  {
    "file": "sample-module/.../jobhandler/outbound/SampleOutboundJob.java",
    "line": 24,
    "className": "SampleOutboundJob",
    "package": "com.example.app.demo.jobhandler.outbound",
    "handlerName": "sampleOutboundJob",
    "api": "old",
    "valueForm": "literal"
  }
]
```

`valueForm`:`literal` | `constant:Cls.CONST`(已解析)| `unresolved:Cls.CONST`(同文件没找到常量,需人工看)| `unrecognized:<token>`(其它少见形式)。`package` 可供核对报告按业务域分组。

- 0 命中 → 空数组 `[]`,stderr 提示检查 `--root/--glob/--api`(非异常退出)。
- 单文件读错 → 跳过,stderr 计数,不中断。
- `--root` 不是目录 → 报错退出 1。

## 4. 注意

- **离线**:不碰任何密钥/控制台,本工具没有、也不需要配置文件。
- **同文件常量解析**:v1 只在同文件内解析 `<Cls>.<CONST>`;跨文件常量引用不在 v1(会落到 `unresolved:`,人工跟)。
- **单行注解假设**:`@JobHandler(...)` 视为单行(多行写法罕见,可能漏);但值里的 `)` 能容忍(如 `@JobHandler("a)b")` 正确取 `a)b`)。
- **`className` 为直接所在类型**:类/接口/枚举级注解能取到;**方法级**注解(新 API `@XxlJob` 常见)取不到、`className` 为空——可从 `package`/文件名辨认。
- **正则扫描(无 AST)**:注释里出现的注解(含被注释掉的旧声明)也会被当成命中;复核留意 `unrecognized:` 条目。
- **Java only**(v1);xxl-job 的 handler 注解是 Java。
