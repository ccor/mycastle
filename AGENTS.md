# AGENTS.md

This file provides guidance to agents working on the **mycastle** package itself.

## What this repository is

**mycastle** is an npm package: a personal workspace toolkit. It (a) scaffolds workspaces (`init`) and (b) ships cross-platform read-only CLIs (Kibana / XXL-Job / Archery / MySQL / repo-changes). Skill management is delegated to the [`skills`](https://github.com/vercel-labs/skills) CLI — skills live in this repo's `skills/` dir (the GitHub source `skills add` pulls from) and are **not** bundled into the npm tarball. Workspaces are *separate* repos created by `mycastle init`; this repo is the package source.

## Architecture

- **One file runs everywhere.** `src/*.ts` are compiled by `tsc` to `dist/*.js` (ESM, NodeNext). No `tsx` at runtime for consumers — only `node dist/cli.js` (exposed as the `mycastle` bin).
- `src/cli.ts` is the router: dispatches `init`/`self-update` to `src/commands/*`, and tool names to `src/<tool>.js` (dynamic import, call exported `run(argv)`).
- **All platform-specific logic lives in `src/lib/platform.ts`** (OS detection, `configDir`, `ensureDir`). Business tools stay platform-agnostic.
- Paths go through `node:path`'s `path.join(...)` — never hand-concatenate `/` or `\`.
- `src/lib/*.ts` are shared helpers (clients, config loaders, session stores). New tools import helpers as `"./lib/..."` with the `.js` extension (NodeNext requires it; source uses `.js` even though the file is `.ts`).
- `tsconfig.json` is strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `NodeNext`). Type imports use `import type`.

**Per-user data dir** (`configDir` in platform.ts): Windows `%LOCALAPPDATA%\mycastle`, Unix `~/.config/mycastle`. State files (e.g. `state.json`, session cookies) live here, never in the package.

### Skills: GitHub is the source of truth

Skills live in **this repo's `skills/`** directory — the GitHub source the `skills` CLI pulls from (`skills add ccor/mycastle`). They are **not** bundled into the npm tarball (`skills/` is absent from `files` in `package.json`), so editing a skill does NOT require an npm release: commit and push to GitHub, then `skills update` (or `npx skills@latest add ccor/mycastle --all`) in each workspace. The CLI tracks each install with `skillFolderHash` in `.skill-lock.json` and warns before overwriting local edits. `init --skills` runs `skills add` for you (opt-in; failure only warns) — `init` alone does not install skills.

### Templates

`templates/` holds workspace scaffolds (`*.tpl` files are copied verbatim by `init`; the `.tpl` suffix is stripped on write). These contain no secrets.

### Collector-not-summarizer contract

Tools **only collect and emit structured JSON to stdout** — no summarization, no LLM logic inside a tool. An agent reads the JSON and writes the prose.

### Extension API

- `import { ArcheryClient } from "mycastle"` (backed by `src/index.ts`) is the **stable programmatic surface**. It is a curated re-export of the lib modules — add new public exports there deliberately, renaming cross-module collisions with `as` (e.g. `resolveEnvs` → `resolveKibanaEnvs` / `resolveArcheryEnvs` / `resolveXxljobEnvs`).
- Deep imports (`mycastle/dist/lib/*.js`) stay available (there is no `exports` map), but changing their signatures is treated as a **minor-version breaking change**.
- The CLI tool contract is `export async function run(argv: string[]): Promise<void>` (type `ToolRun` in `src/index.ts`); `src/cli.ts` routes to it via dynamic import. `src/index.ts` must stay re-export-only: no side effects, never import `./cli.js`.

## Commands

```bash
npm install              # first time
npm run build            # tsc → dist/ (required before running dist/cli.js)
npm run typecheck        # tsc --noEmit
node dist/cli.js hello   # smoke test (equiv. to the published `mycastle hello`)
node dist/cli.js env
npm run hello            # tsx src/hello.ts — run a tool directly without building
```

## Development loop (local, no publish)

Daily changes are validated locally without touching npm. Two modes:

**Linked — default for frequent edits.** `dist/` is symlinked globally; rebuild takes effect immediately everywhere:

```bash
npm link                  # one-time: registers the `mycastle` bin globally (symlink)
npm run build             # after each edit → immediately visible as `mycastle <cmd>`
```

From any workspace: `mycastle env`, etc. run the latest built code.

**Packed — real-install simulation, use before publishing.** Verifies that the `files` whitelist, `bin`, and shebang behave as end users will see:

```bash
npm unlink -g mycastle                # remove the symlink first
npm pack                              # builds mycastle-<ver>.tgz (honors `files`)
tar tf mycastle-<ver>.tgz             # confirm only dist/ templates/, no secrets, no skills/
npm install -g mycastle-<ver>.tgz     # real install (copy, not link)
mycastle --version                    # verify from any dir
```

Switch back to linked mode: `npm uninstall -g mycastle && npm link`.

Publish (`npm publish`) only when a packed install checks out clean. See also the split-plan doc §7 in the source workspace's `docs/architecture/`.

## Config / secrets

The package contains **no secrets**. Consumers keep credentials in their workspace's gitignored `.myws/` dir or env vars. The `.example` files under `templates/examples/` document the schemas.

**Rule: never read credential files raw.** Do not cat/read/grep `.myws/*.config.json` or `.env` — file contents flow into the conversation context and out to model servers. Enumerate with the redacted commands instead:

- `mycastle mysql conns` — connections: name/host/port/user/database, password always `"***"`
- `mycastle archery envs` / `mycastle xxljob envs` — envs: name + url + username, never passwords
- `mycastle kibana envs` — envs: name + url + auth kind, never keys/passwords

Read a credential file only when the user explicitly asks for it and accepts the exposure. The workspace-facing copy of this rule ships in `templates/AGENTS.md.tpl`; each tool doc carries a ⚠️ note with the same command list.

## Shell encoding on Windows (PowerShell UTF-8)

The bash tool invokes PowerShell **non-interactively**, so `$PROFILE` is NOT loaded and the default output encoding is GB2312 (CodePage 936) — non-ASCII output gets corrupted.

**Rule:** when a command may emit non-ASCII bytes, prepend once per invocation:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; <command>
```

These are session-scoped; each bash tool call is a fresh process, so re-apply every time. For pure ASCII output (`git status`, `npm run build`) skip the prefix.

## Editing the `aliyun-devops-cli` skill

Two rules:

- **The one critical gotcha** (lead with it): Yunxiao authenticates with a **Personal Access Token via env vars** (`ALIBABA_CLOUD_YUNXIAO_*`), NOT `aliyun configure` AK/SK profiles. ~300 commands — never memorize flags.
- **Lookup ladder**: `<cmd> --help` → `references/commands.md` → official docs → **write the conclusion back into `references/commands.md`**. Never bundle raw `--help` or doc pages into the skill.

## Conventions

- Filenames are **kebab-case**.
- Write to the user in Chinese for prose/docs; keep code comments and skill internals in English.
- Before publishing: `npm run build`, verify `node dist/cli.js hello`, and confirm `npm pack` contains only `dist/ templates/` (no secrets; `skills/` is intentionally absent — it ships from GitHub, not npm).
