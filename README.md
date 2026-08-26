# mycastle

Personal workspace toolkit — scaffold a work hub and run cross-platform read-only CLIs. Skill management is delegated to the [`skills`](https://github.com/vercel-labs/skills) CLI.

## Install

```bash
npm install -g mycastle
```

## Quick start

```bash
mycastle init my-workspace     # scaffold a new workspace
cd my-workspace
mycastle env                   # print your shell/OS/toolchain
```

`init` creates `docs/` + `.myws/` and writes template files (README/AGENTS/CLAUDE/.gitignore). Skills install is **optional** — add `--skills` to install into `.agents/skills/` + `.claude/skills/` via the `skills` CLI (`npx skills add ccor/mycastle --all`; best-effort — failure only warns), or run that command later.

## Commands

```
Workspace management:
  init [dir]            scaffold a new workspace
  self-update           update the mycastle package (npm)

Tools (run "mycastle <tool> --help" for details):
  hello                 smoke test
  env                   OS/shell/toolchain + shell quoting cheat-sheet
  changes               collect repo changes → JSON
  kibana <cmd>          read-only Kibana CLI
  xxljob <cmd>          read-only XXL-Job admin CLI
  xxljob-scan           offline-scan Java source for xxl-job handlers → JSON
  archery <cmd>         read-only Archery DB portal CLI
  mysql <cmd>           MySQL inspection + DDL execution CLI
```

## Update

```bash
mycastle self-update      # npm update -g mycastle (updates the package only)
skills update             # refresh skills installed in this workspace
```

Skills are pulled from this repo's `skills/` dir on GitHub by the `skills` CLI and tracked in `.skill-lock.json` — updating them does not require an npm release.

## Credentials

Tools read secrets only from gitignored files under `.myws/` (or env vars), never from flags. See each tool's `--help`. The package itself contains no secrets.

Agents must never read `.myws/*` files or `.env` raw — the contents flow into their conversation context and out to model servers. Enumerate with the redacted commands instead: `mycastle mysql conns` (password always `"***"`) and `mycastle archery|xxljob|kibana envs` (name + url + username; never passwords).

## Development

```bash
git clone <mycastle-repo>
cd mycastle
npm install
npm run build            # tsc → dist/
node dist/cli.js hello   # smoke test
npm run typecheck        # tsc --noEmit
```

Source layout: `src/*.ts` = CLI tools (each exports `run(argv)`); `src/lib/*.ts` = shared helpers; `src/cli.ts` = command router; `src/commands/*.ts` = init/self-update; `skills/` = GitHub source the `skills` CLI pulls from (not in the npm tarball); `templates/` = workspace scaffolds.
