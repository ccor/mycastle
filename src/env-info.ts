// env-info.ts — print the current shell / OS / tooling environment, plus a compact
// quoting & JSON-parsing cheat-sheet for the shell(s) the LLM's tools expose.
//
// Run on demand so the LLM (or a human) can see exactly what it is operating in
// before issuing commands — this is what stops the recurring class of failures
// where PowerShell syntax lands in the Bash tool, or JMESPath backtick literals
// get stripped, etc.
//
// Invoked via: mycastle env

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import os from "node:os";
import { arch, isWindows, platform, platformLabel } from "./lib/platform.js";

const NA = "n/a";
const PROBE_TIMEOUT_MS = 4000;

/** Run a command, return trimmed stdout, or null on failure/timeout. Never throws. */
function probe(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string | null {
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      ...opts,
    });
    if (res.error || res.status !== 0) return null;
    const out = ((res.stdout as string | null) ?? "").trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

const firstLine = (s: string): string => (s.split("\n")[0] ?? "").trim();

// --- What to probe ---------------------------------------------------------

type Block = "powershell" | "bash";

/** Shells the LLM's tools may use; `block` selects which cheat-sheet applies. */
const SHELL_PROBES: { name: string; block: Block; cmd: string; args: string[] }[] = [
  { name: "pwsh", block: "powershell", cmd: "pwsh", args: ["--version"] },
  {
    name: "powershell",
    block: "powershell",
    cmd: "powershell",
    args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
  },
  { name: "bash", block: "bash", cmd: "bash", args: ["--version"] },
  { name: "zsh", block: "bash", cmd: "zsh", args: ["--version"] },
  { name: "sh", block: "bash", cmd: "sh", args: ["-c", "echo sh"] },
];

const CLI_PROBES: { name: string; cmd: string; args: string[] }[] = [
  { name: "node", cmd: "node", args: ["--version"] },
  { name: "npm", cmd: "npm", args: ["--version"] },
  { name: "tsx", cmd: "tsx", args: ["--version"] },
  { name: "git", cmd: "git", args: ["--version"] },
  { name: "gh", cmd: "gh", args: ["--version"] },
  { name: "aliyun", cmd: "aliyun", args: ["version"] },
];

/**
 * Best-effort identification of the shell that launched this script. Env vars
 * survive the npm/npx launch chain — unlike the immediate parent PID, which is
 * `node` when run via `npm run` — so they identify the real shell reliably.
 */
function launchingShell(): string {
  const env = process.env;
  if (env.MSYSTEM || env.MINGW_PREFIX) return `bash - Git Bash (${env.MSYSTEM ?? "MSYS"})`;
  if (env.SHELL) return `bash/sh - SHELL=${env.SHELL}`;
  if (isWindows) return "powershell or cmd (no SHELL/MSYSTEM env set)";
  return NA;
}

// --- The lessons (kept short; each line is one actionable rule) ------------

const CHEATSHEETS: Record<Block, string[]> = {
  powershell: [
    "Run cmdlets (Get-ChildItem, ConvertFrom-Json, ...) in the PowerShell tool — NOT the Bash tool.",
    "`&&` / `||` chaining works only in PowerShell 7 (pwsh); Windows PowerShell 5.1 does NOT support it.",
    "Backticks ` are PowerShell's escape char — JMESPath literals like `x` get stripped when passed to a native exe. Filter in the shell instead:  ... | ConvertFrom-Json | Where-Object {...}",
    "ConvertFrom-Json rejects objects with an empty-string ('') key. Use -AsHashtable AND index access $_[key] (dot-access $_.key returns nothing on a hashtable); or project server-side via --cli-query '[].{...}'.",
    "Env vars are $env:NAME (not $NAME); suppress stderr with 2>$null (not 2>/dev/null).",
    "Here-string: the closing '@ MUST sit at column 0. Single-quoted @'...'@ is literal; double-quoted @\"...\"@ interpolates.",
    "Do not prefix commands with cd / Set-Location — the working directory is already the project root.",
  ],
  bash: [
    "POSIX syntax only — no cmdlets. ls/grep/cat work but prefer the dedicated tools (Glob/Grep/Read).",
    "Env vars are $NAME; suppress stderr with 2>/dev/null; single quotes are literal, double quotes interpolate.",
    "On Windows this tool is Git Bash: backslashes in paths need escaping or quoting — prefer forward slashes.",
    "Run PowerShell cmdlets from the PowerShell tool, not here — Get-ChildItem/ConvertFrom-Json do not exist in bash.",
  ],
};

// --- Printing --------------------------------------------------------------

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}
function kv(key: string, value: string): void {
  console.log(`  ${key.padEnd(16)} ${value}`);
}
function bullet(line: string): void {
  console.log(`  - ${line}`);
}

// --- Main ------------------------------------------------------------------

export function run(_argv: string[] = []): void {
  // == Environment ==
  section("Environment");
  kv("OS", `${platformLabel} (${platform}/${arch})`);
  kv("OS version", `${os.version()} (build ${os.release()})`);
  kv("Node", process.versions.node);
  kv("CWD", process.cwd());
  kv("Node text I/O", "UTF-8");
  if (isWindows) {
    const chcp = probe("chcp.com", []);
    const cp = chcp?.match(/\d+/)?.[0];
    kv("console code page", cp ? `CP ${cp}` : NA);
  } else {
    kv("locale", process.env.LC_ALL ?? process.env.LANG ?? NA);
  }

  // == Shells (on PATH) ==
  section("Shells (on PATH)");
  const blocks = new Set<Block>();
  let anyShell = false;
  for (const p of SHELL_PROBES) {
    const v = probe(p.cmd, p.args);
    if (v) {
      anyShell = true;
      blocks.add(p.block);
      kv(p.name, firstLine(v));
    }
  }
  if (!anyShell) kv("(none detected)", NA);
  kv("launched from", launchingShell());

  // == Tooling CLIs ==
  section("Tooling CLIs (on PATH)");
  let anyCli = false;
  for (const c of CLI_PROBES) {
    const v = probe(c.cmd, c.args);
    if (v) {
      anyCli = true;
      kv(c.name, firstLine(v));
    }
  }
  if (!anyCli) kv("(none detected)", NA);

  // == Cheat-sheet(s) for the detected shell(s) ==
  for (const block of ["powershell", "bash"] as const) {
    if (!blocks.has(block)) continue;
    section(
      `Cheat-sheet: ${block === "powershell" ? "PowerShell (pwsh / powershell)" : "Bash (POSIX)"}`,
    );
    for (const line of CHEATSHEETS[block]) bullet(line);
  }

  console.log("");
}
