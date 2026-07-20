# repo-changes — 仓库改动采集器

> 代码:`repo-changes.ts` + `lib/repos-config.ts` + `lib/git-collect.ts` + `lib/state.ts`;示例配置 `repos.config.example.json`。

## 用途

一次性 CLI,用 simple-git 采集"自上次以来每个仓库的新增提交 + diffstat",以**结构化 JSON 输出到 stdout**。用于跨多个本地仓库的增量改动盘点。

## 配置

`.myws/repos.config.json`(gitignored;从 `.myws/repos.config.example.json` 拷贝):

```jsonc
{
  "root": "D:\\proj\\myorg",
  "repos": [
    { "name": "acme-board", "path": "common/acme-board" }
  ]
}
```

- `root`:仓库根目录;`repos[].path` 绝对路径原样用,相对路径依次对 `root`、再对 cwd 解析。
- 状态文件:`configDir/state.json`(`%LOCALAPPDATA%\mycastle` / `~/.config/mycastle`),按 `${name}@${branch}` 记录每仓库上次见到的提交,实现**增量**(只报新提交)。`--since` / `--dry-run` 绕过状态。

## 用法

```bash
mycastle changes                                     # 按配置采集(增量,推进基准)
mycastle changes --repo D:/path/to/repo           # 只跑一个仓库
mycastle changes --since 1d                       # 无状态:最近 1 天
mycastle changes --max-count 5 --dry-run          # 首次预览最近 5 条,不落盘
mycastle changes --no-author --format text        # 省略作者、文本输出
mycastle changes --help                           # 全部 flag
```

调度:一次性任务 + 系统 `cron`(Unix)/ `schtasks`(Win)。JSON 给 agent,由 agent 写概要(见下)。

## 复用与内部要点

### Collector-not-summarizer 契约(关键)

本工具(及任何未来数据工具)**只采集、输出结构化 JSON 到 stdout,不做任何摘要**。由 agent 读取 JSON 后再整理成 prose 概要。**永远不要把 LLM 逻辑塞进工具**。

### 分层管道

- `repo-changes.ts` — CLI:arg 解析、编排多仓库、读写基准状态。
- `lib/repos-config.ts` — 加载 / 校验 `repos.config.json`;绝对 vs 相对(`root`)路径解析。
- `lib/git-collect.ts` — `simple-git` 封装:fetch + log + diffSummary,单仓库,纯数据。
- `lib/state.ts` — 持久化每仓库上次提交(`${name}@${branch}`),支撑增量。

### 注意

- 真实 `repos.config.json` 含机器相关绝对路径,**勿提交**(已 gitignore);只提交 `repos.config.example.json`。
- 首次在某机器用:拷贝 example → 填 `root` / `repos` → 跑 `--dry-run` 预览。
