// update-agents-md.ts — refresh the marker-managed prompt block + scaffold stamp
// of AGENTS.md after a mycastle upgrade. This command owns in-place updates;
// `mycastle init` only scaffolds fresh files and never touches existing ones.
//
// Behaviors by file kind (resolved by walking up from cwd):
//   managed (well-formed mycastle-prompt block):
//     merge — replace the block with the bundled template's version, refresh
//     the stamp; content outside the markers is preserved line-by-line.
//     Hand-edit detection (block hash != recorded stamp hash) → back up the
//     file to AGENTS.md.bak before replacing, then warn.
//     Stamp newer than the running package → refuse (downgrade guard).
//   legacy (pre-marker mycastle scaffold): full rebuild from the template,
//     preserving the user's External-repos notes. ALWAYS backs up first —
//     this is the only full-file rewrite path.
//   foreign (not mycastle-managed): refuse (exit 2) unless --force, which
//     overwrites with the template (user content discarded).
//   missing: point at `mycastle init .`

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  detectEol,
  findAgentsMd,
  inspectScaffold,
  migrateLegacyScaffold,
  updateManagedScaffold,
} from "../lib/managed-blocks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..", "..");

const HELP = `update-agents-md — refresh the managed prompt block of AGENTS.md

Usage:
  mycastle update-agents-md              merge the latest prompt block into AGENTS.md
  mycastle update-agents-md --check      report only: exit 0 fresh / 1 update available / 2 error
  mycastle update-agents-md --force      overwrite even on hand-edited block / foreign file / downgrade
  mycastle update-agents-md --help | -h  show this help

The file is resolved by walking up from the current directory. Content outside
the <!-- mycastle-prompt:begin --> ... end --> markers is preserved verbatim;
a hand-edited block or a legacy scaffold is backed up to AGENTS.md.bak first.
After updating, re-read AGENTS.md so the refreshed guidance takes effect.
`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    return (pkg as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function fail(msg: string, code = 1): never {
  console.error(`error: ${msg}`);
  process.exit(code);
}

export function run(argv: string[]): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const checkOnly = argv.includes("--check");
  const force = argv.includes("--force");
  const pkgVersion = readVersion();

  const tplPath = path.join(pkgRoot, "templates", "AGENTS.md.tpl");
  let templateText: string;
  try {
    templateText = fs.readFileSync(tplPath, "utf8");
  } catch {
    fail(`bundled template missing (${tplPath}) — package may be corrupt.`);
  }

  const agentsPath = findAgentsMd(process.cwd());
  if (!agentsPath) {
    if (checkOnly) {
      console.log("check: no AGENTS.md found (walked up from cwd)");
      process.exit(2);
    }
    fail('no AGENTS.md found (walked up from cwd). Scaffold a workspace first: mycastle init .');
  }

  let existing: string;
  try {
    existing = fs.readFileSync(agentsPath, "utf8");
  } catch {
    fail(`cannot read ${agentsPath}`);
  }
  const info = inspectScaffold(existing);

  if (checkOnly) {
    if (info.kind === "managed") {
      const stale = !info.stamp || info.stamp.version !== pkgVersion;
      console.log(
        stale
          ? `check: update available (scaffold ${info.stamp?.version || "unstamped"}, running ${pkgVersion})`
          : `check: fresh (scaffold ${info.stamp?.version})`,
      );
      process.exit(stale ? 1 : 0);
    }
    if (info.kind === "legacy") {
      console.log(`check: update available (legacy scaffold, running ${pkgVersion})`);
      process.exit(1);
    }
    console.log("check: not mycastle-managed");
    process.exit(2);
  }

  if (info.kind === "foreign") {
    if (!force) {
      fail(
        `${agentsPath} is not mycastle-managed (no prompt block, no legacy signature). ` +
          "Review it manually, then re-run with --force to overwrite (user content discarded).",
        2,
      );
    }
    console.warn(`warn: overwriting non-managed ${agentsPath} (--force); user content discarded.`);
  }

  if (info.kind === "managed" && info.stamp && compareVersions(info.stamp.version, pkgVersion) > 0) {
    if (!force) {
      fail(
        `workspace scaffold (${info.stamp.version}) is newer than the running mycastle (${pkgVersion}). ` +
          "Update the package first; --force overwrites anyway (downgrade).",
      );
    }
    console.warn(`warn: downgrading scaffold ${info.stamp.version} -> ${pkgVersion} (--force).`);
  }

  let result;
  if (info.kind === "managed") {
    result = updateManagedScaffold(existing, templateText, pkgVersion);
  } else {
    // legacy + foreign-with---force both take the rebuild path.
    result = migrateLegacyScaffold(existing, templateText, pkgVersion);
  }

  if (result.handEdited || info.kind === "legacy") {
    const backup = path.join(path.dirname(agentsPath), "AGENTS.md.bak");
    fs.copyFileSync(agentsPath, backup);
    if (result.handEdited) {
      console.warn(
        `warn: managed block had local edits (hash mismatch) — replaced; previous file: ${backup}`,
      );
    } else {
      console.warn(`warn: legacy scaffold migrated — previous file: ${backup}`);
    }
  }

  if (!result.changed && !result.handEdited) {
    console.log(`up-to-date ${agentsPath} (scaffold ${pkgVersion})`);
    return;
  }

  fs.writeFileSync(agentsPath, detectEol(existing) === "\r\n" ? result.text.replace(/\n/g, "\r\n") : result.text, "utf8");
  const action = info.kind === "legacy" ? "migrated" : "merged";
  console.log(`${action} ${agentsPath} (scaffold ${result.version})`);
  console.log("Next: re-read AGENTS.md so the refreshed guidance takes effect.");
}
