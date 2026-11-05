// docs.ts — print bundled tool docs to stdout (read-only; no browser, no pager).
// The docs/ dir is generated at build time from src/*.md (src/README.md excluded)
// and ships inside the npm package, so printed docs always match the running CLI.
// Workspaces should NOT keep their own copies of these docs (they would rot);
// local, machine-specific notes belong in the workspace's docs/notes/ instead.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..", "..");
const docsDir = path.join(pkgRoot, "docs");

/** Tool name → bundled doc file under docs/. Not 1:1: tool aliases share a doc. */
const DOC_FILES: Record<string, string> = {
  archery: "archery.md",
  "data-sync": "data-sync.md",
  env: "env-info.md",
  jenkins: "jenkins.md",
  kibana: "kibana.md",
  mysql: "mysql-helper.md",
  changes: "repo-changes.md",
  prometheus: "prometheus.md",
  "table-sync": "table-sync.md",
  xxljob: "xxljob.md",
  "xxljob-scan": "xxljob-scan.md",
  yapi: "yapi.md",
};

const HELP = `mycastle docs — print bundled tool docs (read-only, stdout)

Usage:
  mycastle docs                      list available docs
  mycastle docs <tool>               print the full doc
  mycastle docs <tool> --schema      print only the doc's config section
  mycastle docs --help | -h          show this help

Docs ship inside the npm package and always match the running CLI version
(sources: src/<tool>.md in the mycastle repo).
`;

/** First markdown H1 ("# ...") of a doc — the one-line summary for listings. */
function firstTitle(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : "(untitled)";
}

/** Read one bundled doc; null when missing (broken package / dev checkout). */
function readDoc(file: string): string | null {
  try {
    return fs.readFileSync(path.join(docsDir, file), "utf8");
  } catch {
    return null;
  }
}

/** All "## " section headings of a doc, for the not-found error message. */
function sectionHeadings(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("## "))
    .map((l) => l.replace(/^##\s+/, "").trim());
}

/**
 * First "## ..." section whose heading mentions the config
 * ("config" case-insensitive, or its Chinese equivalent). Returns null when
 * the doc has no such section.
 */
function configSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const isH2 = (l: string): boolean => l.startsWith("## ");
  const start = lines.findIndex((l) => isH2(l) && /config|配置/i.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isH2(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start, end)
    .join("\n")
    .trimEnd();
}

/** List available docs: tool name + the doc's H1 sentence. */
function listDocs(): void {
  const rows = Object.entries(DOC_FILES).map(([tool, file]) => {
    const text = readDoc(file);
    return `  ${tool.padEnd(14)}${text ? firstTitle(text) : `(doc missing: ${file})`}`;
  });
  console.log(
    `mycastle docs — bundled tool docs (always match the running CLI version)\n\n` +
      `Usage:\n` +
      `  mycastle docs <tool>            print the full doc\n` +
      `  mycastle docs <tool> --schema   print only the doc's config section\n\n` +
      `Available docs:\n${rows.join("\n")}\n\n` +
      `("hello" is a smoke test with no doc; local notes belong in docs/notes/ of your workspace.)`,
  );
}

export function run(argv: string[]): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const schema = argv.includes("--schema");
  const positional = argv.filter((a) => !a.startsWith("-"));
  const tool = positional[0];

  if (!tool) {
    listDocs();
    return;
  }

  if (tool === "hello") {
    console.log(`hello: no bundled doc — it is a smoke test (run "mycastle hello").`);
    return;
  }

  const file = DOC_FILES[tool];
  if (!file) {
    console.error(
      `error: no doc for tool "${tool}". Available: ${Object.keys(DOC_FILES).join(", ")} ("hello" has no doc).`,
    );
    process.exit(2);
  }

  const text = readDoc(file);
  if (text === null) {
    console.error(
      `error: bundled doc missing (docs/ under the package root; dev checkout? run "npm run build" to generate docs/).`,
    );
    process.exit(1);
  }

  if (!schema) {
    console.log(text);
    return;
  }

  const section = configSection(text);
  if (section === null) {
    console.error(`error: docs/${file} has no config section. Available sections:`);
    for (const h of sectionHeadings(text)) console.error(`  ## ${h}`);
    console.error(`(print the full doc with: mycastle docs ${tool})`);
    process.exit(2);
  }
  console.log(section);
}
