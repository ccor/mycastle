// init.ts — scaffold a new workspace: create dirs, write template files (skip
// existing unless --force). Skills install is opt-in (--skills) via the `skills`
// CLI; off by default.
//
// init is a pure scaffold: it never modifies existing files. In-place updates
// of AGENTS.md (the marker-managed prompt block) belong to
// `mycastle update-agents-md`.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stampFreshScaffold } from "../lib/managed-blocks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..", "..");

// GitHub owner/repo that hosts the bundled skills/ dir (this repo). Skills
// install is opt-in via --skills; not run by default.
const SKILL_REPO = "ccor/mycastle";

const HELP = `mycastle init — scaffold a new workspace

Usage:
  mycastle init [dir]            target directory (default: current directory)
  mycastle init [dir] --force    overwrite existing template files
  mycastle init [dir] --skills   also install bundled skills via the \`skills\` CLI
  mycastle init --help | -h      show this help

Creates: docs/  .myws/
Writes (skipped if present, unless --force):
  README.md  AGENTS.md  .gitignore  docs/INDEX.md  .myws/repos.config.example.json

AGENTS.md carries a marker-managed prompt block (see the mycastle-scaffold
stamp inside). After mycastle updates, refresh it in place with:
  mycastle update-agents-md

Skills are NOT installed by default (optional; needs network). Install now with
--skills, or later with: npx skills@latest add ${SKILL_REPO} --all
`;

/** Template mapping: [src under templates/, dest paths relative to workspace root]. */
const SCAFFOLD: Array<[string, string[]]> = [
  ["README.md.tpl", ["README.md"]],
  ["AGENTS.md.tpl", ["AGENTS.md"]],
  ["gitignore.tpl", [".gitignore"]],
  ["docs/INDEX.md.tpl", ["docs/INDEX.md"]],
  ["examples/repos.config.example.json", [".myws/repos.config.example.json"]],
];

export function run(argv: string[]): void {
  const positional = argv.filter((a) => !a.startsWith("-"));
  const force = argv.includes("--force");
  const installSkills = argv.includes("--skills");
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }

  const workspaceRoot = path.resolve(positional[0] ?? process.cwd());
  const templatesSrc = path.join(pkgRoot, "templates");
  if (!fs.existsSync(templatesSrc)) {
    console.error(`No bundled templates found at ${templatesSrc} (package may be corrupt).`);
    process.exit(1);
  }

  // 1. create base dirs
  for (const dir of ["docs", ".myws"]) {
    fs.mkdirSync(path.join(workspaceRoot, dir), { recursive: true });
  }

  // 2. write template files (skip existing unless --force)
  console.log(`Scaffolding workspace at ${workspaceRoot}`);
  for (const [src, dests] of SCAFFOLD) {
    const srcPath = path.join(templatesSrc, src);
    if (!fs.existsSync(srcPath)) {
      console.error(`  ! template missing: ${src}`);
      continue;
    }
    for (const dest of dests) {
      const destPath = path.join(workspaceRoot, dest);
      if (fs.existsSync(destPath) && !force) {
        const hint =
          dest === "AGENTS.md" ? "; refresh in place with: mycastle update-agents-md" : "";
        console.log(`  skip ${dest} (exists${hint})`);
        continue;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const content =
        dest === "AGENTS.md" ? stampFreshScaffold(fs.readFileSync(srcPath, "utf8"), version()) : null;
      fs.writeFileSync(destPath, content ?? fs.readFileSync(srcPath, "utf8"), "utf8");
      console.log(`  wrote ${dest}`);
    }
  }

  // 3. (optional) install skills via the `skills` CLI. Opt-in (--skills): needs
  //    network + a public GitHub repo. Off by default; never fatal.
  //    --all = --skill '*' --agent '*' -y (non-interactive); npx -y skips the install prompt.
  console.log("");
  if (installSkills) {
    try {
      execSync(`npx -y skills@latest add ${SKILL_REPO} --all`, {
        stdio: "inherit",
        cwd: workspaceRoot, // project-scoped: .skill-lock.json lands in the workspace, not globally
      });
      console.log("Skills installed via skills CLI.");
    } catch {
      console.warn(
        `⚠ skills install failed (offline / GitHub repo not public yet?).\n` +
          `  Run manually later: npx skills@latest add ${SKILL_REPO} --all`,
      );
      // do NOT exit 1 — scaffolding already succeeded; skills can be added later.
    }
  } else {
    console.log(
      `Skills not installed (optional). Add them anytime:\n` +
        `  npx skills@latest add ${SKILL_REPO} --all`,
    );
  }

  console.log("\nDone. Next steps:");
  console.log("  - Fill in .myws/*.config.json from the .example files (credentials).");
  console.log("  - Run a tool, e.g.  mycastle env");
  console.log("  - Edit docs/ and README.md to suit your work.");
  console.log("  - Agents: re-read AGENTS.md — it lists the tools of the installed mycastle version.");
}

/** Package version, stamped into freshly written AGENTS.md. */
function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    return (pkg as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
