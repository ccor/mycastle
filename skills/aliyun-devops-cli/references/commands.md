# Routine operations — `aliyun devops` quick reference

Assumes setup (see SKILL.md) is already done — the three env vars are set and a fresh terminal is open. Replace `<...>` with real IDs.

The command **names** are the part worth remembering (there are ~300 of them). The **flags** are easy to look up, so only the high-frequency commands are spelled out below; for everything else run `aliyun devops <command> --help`.

## Global flags (work on every command)

| Flag | What it does |
|---|---|
| `--cli-dry-run` | Print the request that *would* be sent, without executing. Run this before any create/update/delete to sanity-check. |
| `--cli-query '<jmespath>'` | JMESPath filter — print only selected fields from the response. |
| `--pager` / `--all-pages` | Auto-fetch and merge every page of a pageable list — no manual `--page` looping. |
| `--endpoint <url>` / `--region <id>` | Override the service endpoint / region for a single call. |
| `--yunxiao-access-token` / `--organization-id` / `--api-base-url` | Per-call auth (overrides env vars). Avoid — the token lands in shell history. |

## Pagination & filtering patterns

- **Codeup / Flow / Projex** list commands use `--page` + `--per-page`.
- **AppStack** uses a JSON blob instead: `--pagination '{"page":1,"perPage":20}'`.
- Trim output with JMESPath:

```
aliyun devops codeup-list-repositories --page 1 --per-page 20 \
  --cli-query '[].{name:name,id:id}'
```

**List commands return a BARE array.** `aliyun devops` list/search commands (`codeup-list-repositories`, `flow-list-pipelines`, `projex-search-projects`, `base-list-organizations`, `packages-list-repositories`, …) return a bare JSON array at the top level — NOT wrapped in `{result:[...]}`. So `--cli-query` starts at the root: `[]` (never `result[]`). `get-*` commands return an object. If a query returns `null`, dump raw output once to confirm the shape.

**Two PowerShell gotchas when paging a list:**
- **`--pager "path=[]"` and `--cli-query` don't compose** — combining them returns `null` (plugin 0.5.0). To page *and* trim: use `--pager "path=[]"` alone, then pipe to `ConvertFrom-Json` and filter/project in the shell. (Or paginate manually with `--page`/`--per-page` and use `--cli-query`, which works.)
- **`codeup-list-repositories` JSON has an object with an empty-string key** (a `""` property). `ConvertFrom-Json` rejects it (`property whose name is an empty string`). Workarounds: `ConvertFrom-Json -AsHashtable` **but then dot-access fails** — use the indexer `$_['pathWithNamespace']`, not `$_.pathWithNamespace`; or project server-side with `--cli-query '[].{...}'` (only named fields survive → clean `PSCustomObject` with working dot-access) over `--page`/`--per-page`.

---

## Codeup — 代码管理 (repos, branches, merge requests, files, commits)

```
# Repos (flags confirmed)
aliyun devops codeup-list-repositories --page 1 --per-page 20
aliyun devops codeup-get-repository --repository-id <repo-id>
aliyun devops codeup-create-repository                # body flags: codeup-create-repository --help
aliyun devops codeup-update-repository --repository-id <repo-id>

# Branches / tags / files / commits  (pass the repo id; run <cmd> --help for exact flags)
aliyun devops codeup-list-branches
aliyun devops codeup-create-branch
aliyun devops codeup-list-tags
aliyun devops codeup-list-files
aliyun devops codeup-create-file
aliyun devops codeup-update-file
aliyun devops codeup-list-commits
aliyun devops codeup-get-compare                       # diff between two refs

# Merge requests
aliyun devops codeup-list-merge-requests
aliyun devops codeup-get-merge-request
aliyun devops codeup-list-merge-request-comments
# (a parallel change-request API also exists: codeup-list-change-requests, codeup-create-change-request, codeup-merge-change-request …)
```

## Cloning Codeup repos — check git auth first

Codeup must know who you are over SSH or HTTPS before `git clone`. **Probe first, set up the missing one, then clone.** Skipping this, a private-repo clone in a non-interactive shell (CI, AI tool session) just hangs on a credential prompt — so always probe before bulk operations.

Set `GIT_TERMINAL_PROMPT=0` so an auth failure fails fast instead of hanging:

```powershell
$env:GIT_TERMINAL_PROMPT = '0'
# SSH ready?
ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -T git@codeup.aliyun.com
#   welcome line      ⇒ SSH works
#   "Permission denied (publickey)" ⇒ no SSH key registered
# HTTPS creds cached?  (any repo you can read)
git ls-remote --heads https://codeup.aliyun.com/<org>/<group>/<repo>.git
#   lists refs  ⇒ HTTPS auth already configured
#   auth error  ⇒ not set up
```

If neither works, set up one — then re-probe to confirm:
- **SSH** (good for frequent push/pull): `ssh-keygen`, then register the public key in Codeup (web UI: 个人设置 → SSH 公钥, or `aliyun devops codeup-create-ssh-key`). Verify with `ssh -T git@codeup.aliyun.com` (welcome line = ready; `Permission denied (publickey)` = not). Clone with `sshUrlToRepo`. **For CI / non-interactive shells** the key must be in `ssh-agent` or passphrase-less — a passphrase prompt never appears there, so the clone just fails with `publickey`. On Windows, ensure the OpenSSH `ssh-agent` service is running and the key is added.
- **HTTPS** (simplest on Windows): Git Credential Manager (bundled with Git for Windows) caches creds in Windows Credential Manager. On the first interactive clone it prompts for your **Codeup HTTPS username + access token** — the username is shown at 仓库 → 克隆 → HTTPS in the web UI (easiest source). The `codeup-get-member-https-clone-username` API needs a `--user-id` and often returns **403** without an extra token scope, so don't rely on it. Later clones/pulls are passwordless. Clone with `httpUrlToRepo`.

Bulk clone into per-group folders (PowerShell; assumes auth is set up):
```powershell
$env:GIT_TERMINAL_PROMPT = '0'
$root = 'D:\proj\myorg'
$repos = (aliyun devops codeup-list-repositories --page 1 --per-page 100 `
  --cli-query '[].{p:pathWithNamespace,h:httpUrlToRepo,s:sshUrlToRepo}') | ConvertFrom-Json
foreach ($r in $repos) {
  $rel = ($r.p -split '/',2)[1]                 # drop leading org → group/.../repo
  $dest = Join-Path $root ($rel -replace '/','\')
  if (Test-Path (Join-Path $dest '.git')) { "skip (exists): $rel"; continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  git clone --quiet $r.h $dest                  # $r.h = https ; use $r.s for ssh
  if ($LASTEXITCODE -eq 0) { "cloned: $rel" } else { "FAILED ($LASTEXITCODE): $rel" }
}
```

**Verify on disk, not just the log.** On Windows `.git` is a *hidden* directory, so `Get-ChildItem -Filter .git` returns nothing — use `Get-ChildItem -Recurse -Force -Directory -Filter .git` or `Test-Path <repo>\.git` per repo, and confirm the count matches the repo list rather than trusting clone exit codes alone.

## Flow — 流水线 (pipelines, runs, jobs, variable groups, service connections)

```
# Pipelines
aliyun devops flow-list-pipelines --page 1 --per-page 20
aliyun devops flow-get-pipeline --pipeline-id <pipeline-id>
aliyun devops flow-create-pipeline                      # body flags: --help

# Trigger a run  (flags confirmed)
aliyun devops flow-create-pipeline-run --pipeline-id <pipeline-id>
# optional: --params '<json>'

# Runs  (flags confirmed)
aliyun devops flow-list-pipeline-runs --pipeline-id <pipeline-id> --page 1 --per-page 20
aliyun devops flow-list-pipeline-runs --pipeline-id <pipeline-id> --status RUNNING      # filter by status
aliyun devops flow-get-pipeline-run --pipeline-id <pipeline-id> --pipeline-run-id <run-id>
aliyun devops flow-get-latest-pipeline-run --pipeline-id <pipeline-id>

# Jobs & logs  (run <cmd> --help for ids)
aliyun devops flow-list-pipeline-jobs
aliyun devops flow-get-pipeline-job-run-log
aliyun devops flow-get-pipeline-job-step-log

# Control a failed/stuck job run
aliyun devops flow-retry-pipeline-job-run
aliyun devops flow-rerun-pipeline-job-run
aliyun devops flow-stop-pipeline-job-run
aliyun devops flow-skip-pipeline-job-run

# Variable groups & service connections
aliyun devops flow-list-variable-groups
aliyun devops flow-get-variable-group
aliyun devops flow-create-variable-group
aliyun devops flow-list-service-connections
```

## Projex — 项目协作 (projects, work items, sprints, milestones, members)

```
# Projects — searching & "my projects"
# ⚠ search-projects with NO --conditions returns ALL public projects in the org,
#   NOT "the projects I'm in" — most are visible only because scope=public.
#   To get projects you actually participate in / manage, filter with --conditions
#   using the conditionGroups structure (matches the ListProjects API).
aliyun devops projex-search-projects --page 1 --per-page 100  # all public projects (rarely what you want)
aliyun devops projex-get-project                        # project id: --help
aliyun devops projex-create-project

# Current token-holder's user id — needed to build any "my projects" filter
aliyun devops base-get-user-by-token --cli-query 'id'          # e.g. 6a3de085...

# "Projects I PARTICIPATE IN" — members CONTAINS me  (PowerShell; bash = same JSON, single-quote it)
$uid = (aliyun devops base-get-user-by-token --cli-query 'id' | ConvertFrom-Json)
$cond = '{"conditionGroups":[[{"className":"user","fieldIdentifier":"users","format":"multiList","operator":"CONTAINS","value":["' + $uid + '"]}]]}'
aliyun devops projex-search-projects --page 1 --per-page 100 --conditions $cond `
  --cli-query '[].{name:name, code:customCode, id:id, status:status.name}'

# "Projects I MANAGE" — identical shape, just swap the fieldIdentifier:
#   ..."fieldIdentifier":"project.admin"...

# Project members — TWO traps vs other list commands:
#   1) the flag is --id <projectId>, NOT --page/--per-page (use --pager to page).
#   2) member objects use userId / userName / roleId / roleName  (NOT name / role.name).
aliyun devops projex-list-project-members --id <project-id> `
  --cli-query "[?userId=='$uid'].{name:userName, role:roleName}"

# Work items — searching & useful fields
# search-workitems REQUIRES two args and a lowercase sort:
#   --category Req|Bug|Task        (Req=需求, Bug=缺陷, Task=任务)
#   --space-id  <projectId>        (a project IS the work-item space; pass the project id)
#   --sort      desc|asc           (UPPERCASE → HTTP 400 "sort参数不合法，sort只能是 desc 或 asc")
# Recent items in a project, newest first (PowerShell):
aliyun devops projex-search-workitems --category Req --space-id <projectId> `
  --page 1 --per-page 10 --order-by gmtModified --sort desc `
  --cli-query '[].{sn:serialNumber, subject:subject, status:status.name, assignee:assignedTo.name, sprint:sprint.name, modified:gmtModified}'
# Status distribution over the last N — project status.name, then group/count in your shell:
#   ... --per-page 30 --cli-query '[].status.name'
aliyun devops projex-get-workitem --id <workitem-id>      # flag confirmed
aliyun devops projex-create-workitem
aliyun devops projex-update-workitem --id <workitem-id>

# Work-item object — fields worth projecting (for --cli-query):
#   serialNumber (e.g. WUUM-1234), subject, status.name, assignedTo.name,
#   creator.name, sprint.name, gmtModified, gmtCreate, categoryId
# Gotcha: a project's own gmtModified does NOT move with work-item activity — to tell if a
# project is alive, read the newest work items' gmtModified, not the project entity.

# Iterations & people
aliyun devops projex-list-sprints --id <projectId>   # fields: name, status (TODO/ARCHIVED…), owners, gmtCreate, startDate/endDate
aliyun devops projex-list-milestones
# (project members: projex-list-project-members — see "Projects" above for its --id flag & field traps)
```

## AppStack — 应用交付 (applications, environments, change orders)

```
# Applications (flags confirmed)
aliyun devops app-stack-list-applications --pagination '{"page":1,"perPage":20}' --order-by createdAt
aliyun devops app-stack-get-application
aliyun devops app-stack-create-application

# Environments & change orders
aliyun devops app-stack-list-environments
aliyun devops app-stack-list-change-orders
aliyun devops app-stack-get-change-order
```

## Base — 基础信息 (org, members, identity)

```
aliyun devops base-list-organizations                   # orgs the token can see
aliyun devops base-get-user-by-token                    # who does this token belong to? handy identity check
aliyun devops base-list-members
aliyun devops base-list-departments
```

## Other modules

```
# Packages — 制品仓库
aliyun devops packages-list-repositories
aliyun devops packages-list-artifacts
aliyun devops packages-get-artifact

# TestHub — 测试管理
aliyun devops test-hub-search-testcases
aliyun devops test-hub-list-test-plan

# Lingma — 通义灵码 (AI knowledge bases, developer seats)
aliyun devops lingma-list-knowledge-bases

# Insight — 效能洞察
aliyun devops insight-list-queries
```

## The full catalog

`aliyun devops --help` prints every command. Filter it to a module, e.g. (PowerShell):

```powershell
aliyun devops --help | Select-String 'flow-'
```
