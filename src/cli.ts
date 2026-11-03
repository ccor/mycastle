#!/usr/bin/env node
// cli.ts — mycastle command router. Dispatches to bundled tools or workspace
// management commands. Per-command help is delegated to each tool's --help.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

const HELP = `mycastle — personal workspace toolkit

Usage:
  mycastle <command> [args...] [options]

Workspace management:
  init [dir]            scaffold a new workspace (default: current dir)
  self-update           update the mycastle package (npm)
  docs [tool]           print bundled tool docs (--schema: config section only)
  doctor                health check: runtime / install match / .myws configs

Tools (run "mycastle <tool> --help" for details):
  hello                 smoke test — print platform + data dir
  env                   print OS/shell/toolchain + shell quoting cheat-sheet
  changes               collect repo changes since last run → JSON
  kibana <cmd>          read-only Kibana CLI
  xxljob <cmd>          read-only XXL-Job admin CLI
  xxljob-scan           offline-scan Java source for xxl-job handlers → JSON
  archery <cmd>         Archery DB portal CLI (reads + gated ticket writes: --yes)
  prometheus <cmd>      read-only Prometheus HTTP API CLI (query/range/series/targets)
  yapi <cmd>            YApi CLI (docs browse/export + gated writes: --apply)
  mysql <cmd>           MySQL inspection + DDL execution CLI
  data-sync copy <opts> copy table data Source → mysql Dest
  table-sync <cmd>      diff two archery envs / generate manual sync SQL (read-only)

Options:
  -h, --help            show this help (or per-command help)
  -V, --version         print version
`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    return (pkg as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const TOOLS: Record<string, () => Promise<{ run: (a: string[]) => unknown }>> = {
  hello: () => import("./hello.js"),
  env: () => import("./env-info.js"),
  changes: () => import("./repo-changes.js"),
  kibana: () => import("./kibana.js"),
  xxljob: () => import("./xxljob.js"),
  "xxljob-scan": () => import("./xxljob-scan.js"),
  archery: () => import("./archery.js"),
  prometheus: () => import("./prometheus.js"),
  yapi: () => import("./yapi.js"),
  mysql: () => import("./mysql-helper.js"),
  "data-sync": () => import("./data-sync.js"),
  "table-sync": () => import("./table-sync.js"),
  docs: () => import("./commands/docs.js"),
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd = "", ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(HELP);
    return;
  }
  if (cmd === "-V" || cmd === "--version") {
    console.log(readVersion());
    return;
  }

  // management commands
  if (cmd === "init") {
    const { run } = await import("./commands/init.js");
    run(rest);
    return;
  }
  if (cmd === "self-update") {
    const { run } = await import("./commands/self-update.js");
    await run(rest);
    return;
  }
  if (cmd === "doctor") {
    const { run } = await import("./commands/doctor.js");
    await run(rest);
    return;
  }

  // tool commands
  const loader = TOOLS[cmd];
  if (loader) {
    const mod = await loader();
    await mod.run(rest);
    return;
  }

  console.error(HELP);
  console.error(`error: unknown command: ${cmd}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(`fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
