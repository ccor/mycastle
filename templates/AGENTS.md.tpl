# Agent guide

Single source of agent guidance for this workspace (Claude Code, Codex, etc. read AGENTS.md natively).
<!-- mycastle-scaffold -->

<!-- mycastle-prompt:begin -->
## Working in this workspace (managed prompt)

This block is owned by the **mycastle** package — `mycastle update-agents-md` refreshes it. Everything outside the markers is yours and is never touched.

- **What this workspace is**: a personal work hub, not an application — `docs/` (inventories + guides), `.myws/` (gitignored per-tool credentials), skills in `.agents/skills/` + `.claude/skills/` managed by the `skills` CLI (tracked in `.skill-lock.json`). Work here means maintaining docs and running mycastle tools.
- **Tool discovery is authoritative**: run `mycastle --help` for the command list of the INSTALLED version; `mycastle docs <tool>` prints bundled docs; `mycastle docs <tool> --schema` prints a tool's config schema. Never assume this file lists every tool — a newer mycastle may add tools this prompt predates.
- **Credential red line**: never read `.myws/*.config.json` or `.env` raw — file contents flow into the conversation context and out to model servers. Enumerate with the redacted per-tool commands instead (`<tool> envs`, `mysql conns`: name + url + auth kind, never keys/passwords/tokens). Read a credential file only when the user explicitly asks and accepts the exposure.
- **Writes are opt-in**: mutating operations run only behind an explicit flag (`--yes` for archery tickets / jenkins trigger+stop, `--apply` for yapi writes).
- **Windows shells**: the bash tool runs PowerShell **non-interactively** (GB2312 output). When a command may emit non-ASCII bytes, prepend once per invocation: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; <command>`
- **Upgrade playbook**: the `mycastle-scaffold` stamp below the title records the generating version. If it differs from `mycastle --version`, nothing is urgent — when you are already about to run a mycastle tool for the user, mention `mycastle update-agents-md` in passing (optional, never blocks the task), then re-read this file. A stale prompt never beats `--help`.
- Examples: `mycastle jenkins -- whoami` · `mycastle archery -- envs` · `mycastle mysql -- conns` · `mycastle changes` · `mycastle doctor`
- `CLAUDE.md` (if present in older workspaces) is a legacy duplicate of this file — safe to delete.
<!-- mycastle-prompt:end -->

## External repos

<!-- 个人: 在此补充你的外部仓库路径与 Maven profile 等约定。 -->

## Notes

<!-- 个人: 自由记录区。 -->
