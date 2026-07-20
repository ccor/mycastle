# Persisting Yunxiao env vars per platform

These set the three Yunxiao env vars persistently so `aliyun devops` works in every new terminal. Replace `<...>` with real values, and set only the vars the user's org type needs (see the table in SKILL.md):
- `ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN` — always
- `ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID` — 中心版 (Central) only
- `ALIBABA_CLOUD_YUNXIAO_API_BASE_URL` — Region 版 only

The token is stored as plaintext by all of these methods. That's the accepted tradeoff versus leaking it through command-line history — but still rotate it, scope it minimally, and delete on leak.

## Windows

Two persistence mechanisms — choose by who needs to see the vars.

**A. User registry variable — visible to ALL processes** (GUI apps, VSCode tasks, cmd, scheduled tasks, not just PowerShell). Best when the user calls `aliyun devops` from anywhere other than a PowerShell terminal:

```powershell
[Environment]::SetEnvironmentVariable("ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN","<token>","User")
[Environment]::SetEnvironmentVariable("ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID","<org-id>","User")
```

**B. PowerShell `$PROFILE` — visible only to processes launched from PowerShell**, but lets you add logic (e.g. pull the token from a secret store at startup instead of hardcoding it):

```powershell
# edit the profile:   notepad $PROFILE     or     code $PROFILE
$env:ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN = "<token>"
$env:ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID = "<org-id>"
```

Notes:
- Find the profile path with `$PROFILE` — e.g. `C:\Users\<user>\Documents\PowerShell\Microsoft.PowerShell_profile.ps1` (PowerShell 7) or `...\WindowsPowerShell\...` (Windows PowerShell 5.1).
- `$env:X = "..."` on its own is **session-only**; the profile line is what makes it load on every startup.
- The execution policy must allow local scripts (`RemoteSigned` or looser). `Get-ExecutionPolicy -List` shows the current state.

After either method: open a **new** terminal. To apply to the current session without reopening, run `. $PROFILE`.

## macOS / Linux

Add `export` lines to the shell rc file — `~/.zshrc` for zsh (macOS default), `~/.bashrc` or `~/.bash_profile` for bash:

```sh
export ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN="<token>"
export ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID="<org-id>"   # 中心版
# export ALIBABA_CLOUD_YUNXIAO_API_BASE_URL="<url>"       # Region 版
```

Then reload: `source ~/.zshrc` (or open a new shell).

## Why a new terminal?

All of these write to a store that is read **once**, when a process starts. Already-open terminals carry a snapshot of the old environment and will not pick up the change. "I set the variable but `aliyun` still can't find it" is almost always a stale-terminal problem — close and reopen it.
