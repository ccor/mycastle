// doctor.ts — one-shot health report for "this machine / this workspace":
//   1. runtime (mycastle / node / platform)
//   2. dual-install check: global CLI version vs the local node_modules copy
//      declared by the cwd's package.json (they drift silently; report it)
//   3. .myws config inventory: status + entry counts only
//
// Output is plain text (same style as init/self-update). RED LINE: doctor never
// prints .myws file contents, URLs, usernames or ANY field value — status words
// and counts only. JSON parse errors report just the "position N" number;
// validation failures print fixed wording, never loader error text (those embed
// absolute paths and quoted config fragments).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadArcheryConfig } from "../lib/archery-config.js";
import { loadKibanaConfig } from "../lib/kibana-config.js";
import { parseMysqlUrl } from "../lib/mysql-config.js";
import { loadPrometheusConfig } from "../lib/prometheus-config.js";
import { loadReposConfig } from "../lib/repos-config.js";
import { loadXxljobConfig } from "../lib/xxljob-config.js";
import { loadYapiConfig } from "../lib/yapi-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..", "..");

const HELP = `mycastle doctor — health check for this machine / workspace

Usage:
  mycastle doctor               check runtime, install match and .myws configs
  mycastle doctor --help | -h   show this help

Pure text report; run it inside a workspace (uses process.cwd()).
Never prints .myws config contents or any field value — status + counts only.
Report-only: always exits 0, even when configs are broken (not a CI gate).
`;

/** Version of the RUNNING mycastle (the package this CLI was loaded from). */
function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    return (pkg as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface WorkspacePkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Declared mycastle version range in <cwd>/package.json, or null. */
function declaredRange(): { range: string } | { error: string } | null {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let pkg: WorkspacePkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as WorkspacePkg;
  } catch {
    return { error: "cwd package.json is not valid JSON — install check skipped" };
  }
  const range = pkg.dependencies?.mycastle ?? pkg.devDependencies?.mycastle ?? null;
  return range ? { range } : null;
}

/** Version installed at <cwd>/node_modules/mycastle, or null when absent. */
function installedVersion(): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "node_modules", "mycastle", "package.json"), "utf8"),
    );
    return (pkg as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** Section 2: global CLI vs local node_modules copy. */
function checkInstall(): string[] {
  const declared = declaredRange();
  if (declared === null) {
    return [
      "pure CLI mode (cwd package.json does not declare mycastle).",
      "upgrade with: mycastle self-update",
    ];
  }
  if ("error" in declared) return [declared.error];

  const running = readVersion();
  const installed = installedVersion();
  if (installed === null) {
    return [
      `NOT INSTALLED: package.json declares mycastle ${declared.range}, but node_modules/mycastle is missing.`,
      `fix: npm i mycastle@${running}`,
    ];
  }
  if (installed !== running) {
    return [
      `MISMATCH: running mycastle ${running} (CLI) but node_modules has ${installed} (declared ${declared.range}).`,
      `fix: npm i mycastle@${running}   (or: npm update mycastle)`,
    ];
  }
  return [`ok: node_modules/mycastle ${installed} matches the running CLI (declared ${declared.range}).`];
}

/** "position N" from a V8 JSON parse error — the only safe fragment to print. */
function parseErrorPosition(msg: string): string {
  const m = /position (\d+)/.exec(msg);
  return m ? ` (at position ${m[1]})` : "";
}

/** Verdict of a config validator: entry summary text plus an optional non-fatal warning. */
interface Verdict {
  text: string;
  warn?: string;
}

/** Status line for a config file: missing / invalid JSON / ok(N) / warn(...) / invalid(fixed wording). */
function checkConfig(
  label: string,
  relPath: string,
  hint: string,
  validate: () => Verdict, // entry summary like "2 envs"; throws on structural problems
): string {
  const p = path.join(process.cwd(), relPath);
  if (!fs.existsSync(p)) return `${label}: missing (${relPath})`;
  let rawText: string;
  try {
    rawText = fs.readFileSync(p, "utf8");
  } catch {
    return `${label}: invalid (unreadable — see: ${hint})`;
  }
  try {
    JSON.parse(rawText);
  } catch (e) {
    const pos = parseErrorPosition(e instanceof Error ? e.message : "");
    return `${label}: invalid JSON${pos} — see: ${hint}`;
  }
  try {
    const v = validate();
    return v.warn
      ? `${label}: warn (${v.text}; ${v.warn} — see: ${hint})`
      : `${label}: ok (${v.text})`;
  } catch {
    return `${label}: invalid (structure; details: ${hint})`;
  }
}

/** Entry summary for the five env-style configs (throws when structurally broken). */
function envCount(loader: () => { envs: Record<string, unknown> }): Verdict {
  const n = Object.keys(loader().envs).length;
  return { text: `${n} env${n === 1 ? "" : "s"}` };
}

/** Entry summary for .myws/db.config.json (flat url or named connections). */
function dbCount(): Verdict {
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), ".myws", "db.config.json"), "utf8"),
  ) as { url?: unknown; connections?: Record<string, { url?: unknown }> };
  const urls: unknown[] =
    typeof raw.url === "string" && raw.url.length > 0
      ? [raw.url]
      : Object.values(raw.connections ?? {}).map((c) => c?.url);
  if (urls.length === 0) throw new Error("no entries");
  if (urls.some((u) => typeof u !== "string" || u.length === 0)) throw new Error("missing url");
  for (const u of urls as string[]) parseMysqlUrl(u); // throws on malformed URL
  return { text: `${urls.length} connection${urls.length === 1 ? "" : "s"}` };
}

/** Entry summary for .myws/repos.config.json (via the repos loader). */
function reposCount(): Verdict {
  const entries = loadReposConfig(path.join(process.cwd(), ".myws", "repos.config.json"));
  const bad = entries.filter((r) => !fs.existsSync(r.path));
  return {
    text: `${entries.length} repos`,
    warn: bad.length > 0 ? `${bad.length} path(s) not found on disk` : undefined,
  };
}

/** Section 3: .myws inventory — status words and counts, never contents. */
function checkMywsConfigs(): string[] {
  const docsHint = (tool: string): string => `mycastle docs ${tool} --schema`;
  return [
    checkConfig("archery", path.join(".myws", "archery.config.json"), docsHint("archery"), () =>
      envCount(() => loadArcheryConfig()),
    ),
    checkConfig("kibana", path.join(".myws", "kibana.config.json"), docsHint("kibana"), () =>
      envCount(() => loadKibanaConfig()),
    ),
    checkConfig("prometheus", path.join(".myws", "prometheus.config.json"), docsHint("prometheus"), () =>
      envCount(() => loadPrometheusConfig()),
    ),
    checkConfig("xxljob", path.join(".myws", "xxljob.config.json"), docsHint("xxljob"), () =>
      envCount(() => loadXxljobConfig()),
    ),
    checkConfig("yapi", path.join(".myws", "yapi.config.json"), docsHint("yapi"), () =>
      envCount(() => loadYapiConfig()),
    ),
    checkConfig("db", path.join(".myws", "db.config.json"), docsHint("mysql"), dbCount),
    checkConfig("repos", path.join(".myws", "repos.config.json"), docsHint("changes"), reposCount),
  ];
}

export function run(argv: string[]): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }

  const configLines = checkMywsConfigs();

  console.log("mycastle doctor\n");
  console.log("[runtime]");
  console.log(`  mycastle ${readVersion()} / node ${process.version} / ${process.platform}`);
  console.log("");
  console.log("[install]");
  for (const line of checkInstall()) console.log(`  ${line}`);
  console.log("");
  console.log("[.myws configs] (status + counts only; contents are never printed)");
  for (const line of configLines) console.log(`  ${line}`);
  const missing = configLines.filter((l) => l.includes(": missing")).length;
  const invalid = configLines.filter((l) => l.includes(": invalid")).length;
  const warn = configLines.filter((l) => l.includes(": warn")).length;
  const ok = configLines.length - missing - invalid - warn;
  console.log(
    `\nsummary: ${ok} ok, ${warn} warn, ${invalid} invalid, ${missing} missing` +
      (missing + invalid === 0
        ? ""
        : ` — copy the .example files under .myws/ and see "mycastle docs <tool> --schema"`),
  );
}
