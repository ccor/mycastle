// copy-docs.mjs — build step: copy src/*.md tool docs into docs/ for npm packaging.
// docs/ is a build artifact (gitignored, shipped via package.json "files"); it is
// regenerated from scratch on every build so stale copies never linger.
// src/README.md is excluded — the package README lives at the repo root.
// Cross-platform by design: plain node fs, no shell cp.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "docs");

fs.mkdirSync(outDir, { recursive: true });

// Clean previous copies so removed/renamed docs disappear from the package.
for (const entry of fs.readdirSync(outDir)) {
  if (entry.endsWith(".md")) fs.rmSync(path.join(outDir, entry));
}

let count = 0;
for (const entry of fs.readdirSync(srcDir)) {
  if (!entry.endsWith(".md") || entry === "README.md") continue;
  fs.copyFileSync(path.join(srcDir, entry), path.join(outDir, entry));
  count++;
}
console.log(`copied ${count} tool doc(s) src/*.md -> docs/`);
