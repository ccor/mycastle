---
name: xxljob-ops
description: Reconcile xxl-job scheduled tasks between Java source code and a target environment's admin console. Use this when someone wants to check which coded xxl-job handlers (@JobHandler / @XxlJob) are actually scheduled in an environment, find code-but-not-configured or console-but-not-coded handlers, or spot handler-name mismatches between code and console. Triggers on "核对 xxljob", "任务调度状态核对", "扫代码里的 xxl-job 任务", "哪些 job 真在环境里跑", "代码和控制台对不上", "xxljob reconcile", "reconcile xxl-job handlers", "which xxl-job jobs are actually scheduled", "code vs console xxl-job". Scope (current): offline source scan + live console snapshot + reconcile. Viewing job run logs and cross-referencing application logs are future extensions, not yet built.
---

# xxl-job code ↔ console reconciliation

## The one thing that trips everyone up

A handler declared in code (`@JobHandler` / `@XxlJob`) **does not mean** it's actually scheduled in the console. Cron schedule, start/stop, sharding, and routing strategy all live in the xxl-job admin console — **you cannot see execution frequency from the source code alone**. This skill's value is **reconciling the two sides**, surfacing three classes of problem: coded-but-not-configured (undeployed / abandoned), configured-but-not-coded (new / lives elsewhere), and handler-name mismatch between the two (contract drift).

Two `mycastle` tools, one per side, both emit JSON. The reconcile join itself is done by you / the agent — the tools only collect:

- **Code side**: `mycastle xxljob-scan --root <src-root>` — offline Java source scan.
- **Console side**: `mycastle xxljob snapshot --env <env>` — live admin-console snapshot.

## Prerequisites & versioning

- `mycastle` on `$PATH` (`npm install -g mycastle`). Check with `mycastle --version`; upgrade the tools with `mycastle self-update`.
- Each tool's `--help` is the **ground truth for the version you have installed** — when a flag or output field matters, read it rather than trusting this doc (the doc lags the code). Tools and this skill version independently: tools come from npm (`mycastle self-update`), this skill from GitHub (`skills update`).
- Console access needs an xxl-job admin endpoint + credentials in `.myws/xxljob.config.json`. `mycastle xxljob envs` lists configured env names without leaking secrets.
- The scanner is **offline**: it touches no keys, no console, no config file — pure source analysis. Same Java-only assumptions as `mycastle xxljob-scan --help`.

## Workflow: scan + reconcile

### 1. Gather inputs

You need two things: a **source root `--root`** and a **target env `--env`** (env names live in `.myws/xxljob.config.json`).

- Not sure which envs are configured? `mycastle xxljob envs` (no secrets leaked).
- `--env` accepts a single name, a comma list, or `all`; a default env may be configured.
- Missing config or wrong `--root`? See `mycastle xxljob --help` (env/config) or `mycastle xxljob-scan --help` (root/globs/api).

### 2. Scan code (code-side handler set)

```bash
mycastle xxljob-scan --root <src-root> --compact
```

Watch entries whose `valueForm` is `unresolved:...` — a constant reference the scanner couldn't resolve within the same file; chase that class's `static final String` by hand. `valueForm: "constant:..."` is a successfully resolved constant; `valueForm: "literal"` is a plain string. (`unrecognized:...` is a rare other form — worth a manual glance, since the regex scan can also pick up annotations sitting inside comments.)

### 3. Pull env state (console-side handler set)

```bash
mycastle xxljob snapshot --env <env>
```

One call fetches every executor + job (recommended). It prints JSON to stdout **and** saves a timestamped copy under the config dir (`.../xxljob/snapshots/<env>/<timestamp>.json`) for reproducibility. Alternatively, page manually: `mycastle xxljob executors list`, then per-executor `mycastle xxljob jobs list`. Either way you get the env-side handlers plus `{cron, description, triggerStatus, jobGroup}`; the same handler registered multiple times (sharding / multiple param sets) yields multiple rows.

### 4. Reconcile join (this step is you / the agent, not a tool)

Key = **handler name, case-insensitive**. The handler value is the contract between console and code, but the two sides can differ in casing, so join on the lowercased name and flag case-only diffs separately. Four buckets:

| Bucket | Meaning | Suggested flag |
|---|---|---|
| Both sides | configured | with `ON`/`disabled`, cron, description; one row per registration |
| In code, not in console | likely undeployed / abandoned | `unconfigured` |
| In console, not in scan | new / in another module / unresolved constant | `not seen in scan` |
| Case-only difference | contract drift | `contract mismatch` (handler value should match verbatim on both sides) |

> Don't mistake a "doc transcription error" for contract mismatch: this skill reads code (scan) and console (snapshot) directly — both are ground truth. A *real* contract mismatch means the literal value in code differs from the literal value in the console.

### 5. Present

A reconciliation report table; suggested columns: `handler | description | cron | status | api | class`. Group by business domain if the scan's `package` suggests one (e.g. `...jobhandler.outbound`). Same handler with multiple registrations: newline within a cell (`<br>`) or one row per registration, ordered by job id ascending.

Two landing options, pick by context:

- **Print the report** (default): show it to the user inline.
- **Annotate an inventory doc** (e.g. a project's scheduled-jobs doc of your choice): pin **timestamp + data source** — code scan date, console snapshot `takenAt`, env, executor name — so a later reader can tell how stale it is.

### 6. Review (common pitfalls)

- **`/joblog` server-side timeout on some envs**: affects **log viewing only**, *not* reconciliation — reconciliation uses `snapshot`, never logs.
- **Auth / connectivity failure**: surfaces as `XxljobApiError` (`status` / `body` / `url` / `env`); see `mycastle xxljob --help`.
- **Scan returns 0 hits**: usually a wrong `--root` / `--glob` / `--api`; run `mycastle xxljob-scan --root <root>` and read stderr.
- **`jobs log` without `--group`**: the tool rejects it — run `mycastle xxljob executors list` first to get the group id.

## Future extensions (not yet built)

- **View job run logs**: `mycastle xxljob jobs log <id> --group N --env <env>` (see `mycastle xxljob --help`). ⚠️ `/joblog` can time out (>60s) on some envs — verify on yours before relying on it for bulk log pulls.
- **Troubleshoot a task** (xxl-job schedule logs + application instance logs): needs a log-search capability this kit doesn't bundle yet; until then, application-log steps are manual via your log UI.

> Detailed flows for these will be added under `references/` when built; not in the current scope.
