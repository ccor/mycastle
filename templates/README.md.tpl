# 个人工作中枢

> 项目、代码、仓库清单与文档的统一入口；日常工作从这里出发，持续迭代。

## 这是什么

个人工作目录：汇集参与的项目、代码与仓库清单，接入常用工具，沉淀通用流程。日常的规划、执行与回顾以此为起点。

本工作区由 [mycastle](https://www.npmjs.com/package/mycastle) 初始化（`mycastle init`）。工具由 mycastle 提供；技能由 [`skills`](https://github.com/vercel-labs/skills) CLI 安装与管理（见 `.skill-lock.json`）。

## 目录

| 路径 | 内容 |
|---|---|
| `docs/` | 文档：仓库清单、工具配置等（导航见 [INDEX.md](docs/INDEX.md)） |
| `.agents/skills/` `.claude/skills/` | 由 skills CLI 安装/管理的工作技能（见 `.skill-lock.json`） |
| `.myws/` | 工具密钥/配置（gitignored，不入库） |

## 已接入技能

- **aliyun-devops-cli** — 云效（Codeup / Flow / Projex）CLI。
- **xxljob-ops** — xxl-job 调度任务核对（代码扫描 vs 控制台）。

## 从这里开始

- 仓库清单与文档 → `docs/`
- 工具命令 → `mycastle <command>`（`mycastle --help` 查看全部）
- 凭据配置 → `.myws/*.config.json`（参考 `.myws/*.example.json`）；枚举环境/连接用 `mycastle … envs` / `mycastle mysql conns`，不要读文件原文
- 更新技能 → `skills update`（首次安装：`npx skills@latest add ccor/mycastle --all`）

## 约定

文件名用 kebab-case；文档按类别建子目录；通用工具与流程由 mycastle 管理。
