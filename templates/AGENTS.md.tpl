# Agent guide

This file provides guidance to AI coding agents (Codex, Claude Code, etc.) working in this workspace. It is installed as both `AGENTS.md` and `CLAUDE.md` — identical content, two filenames for tool compatibility.

## What this workspace is

A **personal work hub** ("个人工作中枢"), not an application. It bundles:

- `docs/` — inventories (remote/local repo lists) and setup guides (云效 CLI, SSH/HTTPS keys).
- `.agents/skills/` + `.claude/skills/` — work skills, installed and managed by the `skills` CLI (tracked in `.skill-lock.json`).
- `.myws/` — per-tool credentials/config (gitignored, never committed).

There is no build step, no server, no app to run. Work here is: maintaining docs and running mycastle tools.

## Commands

```bash
mycastle hello                 # smoke test — print platform + data dir
mycastle env                   # print OS/shell/toolchain + shell quoting cheat-sheet
mycastle changes               # collect repo changes since last run → JSON to stdout
mycastle changes -- --help     # repo-changes flags
mycastle kibana -- status      # Kibana read-only CLI
mycastle xxljob -- envs        # XXL-Job read-only CLI
mycastle xxljob-scan -- --root <src-root>   # offline-scan a Java source root for xxl-job handlers → JSON
mycastle archery -- envs       # Archery read-only CLI
mycastle mysql -- show-databases  # MySQL inspection + DDL CLI
skills update                  # refresh skills installed in .agents/ + .claude/
mycastle --help                # full command list
```

## mycastle

This workspace is managed by the **mycastle** npm package. Skills are installed and tracked by the [`skills`](https://github.com/vercel-labs/skills) CLI (records in `.skill-lock.json`) — run `npx skills@latest add ccor/mycastle --all` to (re)install, `skills update` to refresh. Tool state lives under the per-user data dir: Windows `%LOCALAPPDATA%\mycastle`, Unix `~/.config/mycastle`.

## External repos

<!-- 个人: 在此补充你的外部仓库路径与 Maven profile 等约定。 -->

## Config files (all gitignored, under .myws/)

- `.myws/repos.config.json` — repo-changes machine-specific paths. Copy `.myws/repos.config.example.json`.
- `.myws/xxljob.config.json` — XXL-Job multi-env URLs + credentials.
- `.myws/archery.config.json` — Archery multi-env URLs + credentials.
- `.myws/db.config.json` — MySQL connection URLs (or set `DB_CONN_URL` env var).
- `.env` — credentials/secrets. Read secrets **only** from environment variables; never hardcode or paste tokens into commands (they leak to shell history).

## Shell encoding on Windows (PowerShell UTF-8)

The bash tool invokes PowerShell **non-interactively**, so `$PROFILE` is NOT loaded and the default output encoding is GB2312 (CodePage 936) — Chinese (and other non-ASCII) output gets corrupted like `??ã,????!`.

**Rule:** when a command may emit non-ASCII bytes (Chinese prose, file contents, tool output), prepend this once per invocation:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; <command>
```

Notes:
- These two assignments are session-scoped; each bash tool call is a fresh process, so re-apply every time.
- For pure ASCII output (e.g. `git status`, `mycastle env`) the prefix is unnecessary — skip it to keep commands readable.
- Do NOT rely on `$PROFILE`, `chcp 65001`, or the system "Beta UTF-8" setting inside tool calls; they don't apply to non-interactive children reliably.

## Editing skills

Skills are the highest-value, most easily-rotted artifacts. They are **not** part of this workspace — they live in their source GitHub repo and are installed/tracked here by the `skills` CLI (`.skill-lock.json`). To change a skill: edit it in the source repo, then run `skills update` here (the CLI records `skillFolderHash` and warns before overwriting local edits). Two rules govern skill changes:

- **aliyun-devops-cli gotcha** (lead with it): Yunxiao authenticates with a **Personal Access Token via env vars** (`ALIBABA_CLOUD_YUNXIAO_*`), NOT `aliyun configure` AK/SK profiles. There are ~300 commands — never try to memorize their flags.
- **Lookup ladder for command semantics**: `<cmd> --help` → `references/commands.md` (distilled conclusions) → official docs (fetch the single page) → **write the distilled conclusion back into `references/commands.md`**. Never bundle raw `--help` output or doc pages into the skill.

## Conventions

- Filenames are **kebab-case**. Docs live in category subdirs under `docs/`; **register every new/moved doc in `docs/INDEX.md`**.
- Write to the user in Chinese for prose/docs (the README and tool docs are Chinese); keep code comments and skill internals in English.
