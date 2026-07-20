# env-info — 环境与 shell 速查

> 代码:`env-info.ts`

## 用途

按需运行,打印"我现在在什么环境、该用哪种语法写命令",供 LLM/人在发命令前参考——专门对付"PowerShell 语法掉进 Bash 工具""JMESPath 反引号字面量被吞""ConvertFrom-Json 遇空键名报错"这类反复出现的失败。所有探测都带超时与 try/catch,探不到显示 `n/a`,绝不中断。

## 配置

无。零依赖,直接跑。

## 用法

```bash
mycastle env            # 或 mycastle env-info
```

输出分四节:

- `== Environment ==` — OS / Node / CWD / 编码 / Windows 代码页或 locale。
- `== Shells ==` — PATH 上的 pwsh/powershell/bash/zsh/sh + 版本,以及"本进程由哪个 shell 调起"。
- `== Tooling CLIs ==` — node / npm / tsx / git / gh / aliyun。
- `== Cheat-sheet ==` — 仅对检测到的 shell 打印:PowerShell 与 Bash 各自的引号 / 转义 / JSON 解析要点。

## 复用与内部要点

- 纯打印工具,不提供可 import 的库。
- 建议**发任何 shell 命令前**先跑一次,确认当前 shell 语法(尤其跨 Windows/Unix 切换时)。
