// managed-blocks.ts — the marker-managed prompt block of scaffolded AGENTS.md.
//
// Workspace AGENTS.md files mix package-owned guidance (the agent prompt, which
// must evolve with the mycastle package) and user notes (which must never be
// clobbered). The contract:
//
//   <!-- mycastle-scaffold: 0.1.5 sha:9f2a31c0 -->   ← scaffold stamp: version
//       of the package that last wrote the file + sha256(8) of the block as
//       written then (hand-edit detection)
//   <!-- mycastle-prompt:begin -->                   ← single managed block
//   ...prompt content (package-owned, replaced on update)...
//   <!-- mycastle-prompt:end -->
//   ...everything else is the user's, preserved line-by-line...
//
// `mycastle update-agents-md` owns in-place updates (merge / migrate / refuse);
// `mycastle init` only scaffolds fresh files.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

export const PROMPT_BEGIN = "<!-- mycastle-prompt:begin -->";
export const PROMPT_END = "<!-- mycastle-prompt:end -->";

/** Placeholder token in the template; init/update replace it with the real stamp. */
const STAMP_TOKEN_RE = /<!--\s*mycastle-scaffold[^>]*-->/;
const STAMP_LINE_RE = /^\s*<!--\s*mycastle-scaffold[^>]*-->\s*$/;

/** Signature of pre-marker scaffolds (every old AGENTS.md.tpl had this heading). */
export const LEGACY_SCAFFOLD_SIGNATURE = "## Shell encoding on Windows";

// --- stamp ------------------------------------------------------------------

export interface ScaffoldStamp {
  version: string;
  /** sha256(8) of the block content as last written by a mycastle command. */
  hash: string | null;
}

/** Parse the scaffold stamp line of a file; null when absent. */
export function parseStamp(text: string): ScaffoldStamp | null {
  const line = text.split(/\r?\n/).find((l) => STAMP_LINE_RE.test(l));
  if (!line) return null;
  const m = /mycastle-scaffold:\s*([\w.-]+)/.exec(line);
  if (!m) return { version: "", hash: null };
  const hash = /sha:([0-9a-f]+)/.exec(line);
  return { version: m[1]!, hash: hash ? hash[1]! : null };
}

export function buildStamp(version: string, hash: string | null): string {
  return `<!-- mycastle-scaffold: ${version}${hash ? ` sha:${hash}` : ""} -->`;
}

/** Numeric-ish version compare: -1 (a<b) | 0 | 1 (a>b). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? -1 : 1;
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

// --- block handling ---------------------------------------------------------

function normalizeLines(lines: string[]): string[] {
  const trimmed = lines.map((l) => l.replace(/\s+$/, ""));
  while (trimmed.length && trimmed[0]!.trim() === "") trimmed.shift();
  while (trimmed.length && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
  return trimmed;
}

/** sha256(8) over an EOL- and trailing-space-insensitive normalization. */
export function hashBlock(content: string): string {
  const normalized = normalizeLines(content.replace(/\r\n/g, "\n").split("\n")).join("\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 8);
}

interface BlockSpan {
  begin: number; // line index of the begin marker
  end: number; // line index of the end marker
}

/** Locate the single prompt block; "malformed" when markers are duplicated or inverted. */
function findPromptBlock(
  lines: string[],
): { span: BlockSpan } | { span: null; problem: "malformed" } {
  let begin = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === PROMPT_BEGIN) {
      if (begin !== -1) return { span: null, problem: "malformed" };
      begin = i;
    } else if (t === PROMPT_END) {
      if (end !== -1) return { span: null, problem: "malformed" };
      end = i;
    }
  }
  if (begin === -1 && end === -1) return { span: null, problem: "malformed" };
  if (begin === -1 || end === -1 || end < begin) return { span: null, problem: "malformed" };
  return { span: { begin, end } };
}

/** True when the file carries a well-formed prompt block. */
export function hasPromptBlock(text: string): boolean {
  return findPromptBlock(text.split(/\r?\n/)).span !== null;
}

function extractBlockContent(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const found = findPromptBlock(lines);
  if (!found.span) throw new Error("malformed mycastle-prompt markers");
  return lines.slice(found.span.begin + 1, found.span.end);
}

/** EOL of the file as read — writes preserve it to avoid whole-file diffs. */
export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// --- scaffold classification -------------------------------------------------

export type ScaffoldKind = "managed" | "legacy" | "foreign";

export interface ScaffoldInfo {
  kind: ScaffoldKind;
  stamp: ScaffoldStamp | null;
}

/** Classify an AGENTS.md and read its stamp (one pass, status words only). */
export function inspectScaffold(text: string): ScaffoldInfo {
  if (hasPromptBlock(text)) return { kind: "managed", stamp: parseStamp(text) };
  if (text.includes(LEGACY_SCAFFOLD_SIGNATURE)) return { kind: "legacy", stamp: parseStamp(text) };
  return { kind: "foreign", stamp: null };
}

/**
 * Workspace AGENTS.md resolution for commands and the staleness note: walk up
 * from `startDir` to the filesystem root and return the first AGENTS.md that
 * exists (callers gate on the scaffold stamp/kind). Null when none found.
 */
export function findAgentsMd(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// --- user-content preservation ----------------------------------------------

/** The body (trimmed, placeholder dropped) of the "## External repos" section, or null. */
function extractExternalRepos(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((l) => l.trim() === "## External repos");
  if (h === -1) return null;
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(h + 1, end)
    .filter((l) => !/在此补充/.test(l)) // drop the template placeholder comment
    .map((l) => l.replace(/\s+$/, ""));
  let lo = 0;
  let hi = body.length;
  while (lo < hi && body[lo]!.trim() === "") lo++;
  while (hi > lo && body[hi - 1]!.trim() === "") hi--;
  return hi > lo ? body.slice(lo, hi) : null;
}

/** Splice `userBody` into the template's External-repos section (replacing the placeholder). */
function spliceExternalRepos(templateText: string, userBody: string[]): string {
  const lines = templateText.split(/\r?\n/);
  const h = lines.findIndex((l) => l.trim() === "## External repos");
  if (h === -1) return templateText;
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, h + 2), ...userBody, "", ...lines.slice(end)].join("\n");
}

// --- update operations ------------------------------------------------------

export interface ScaffoldUpdate {
  /** Full file content (LF); caller applies the file's EOL before writing. */
  text: string;
  changed: boolean;
  /** The managed block was modified since the last tool write → back it up. */
  handEdited: boolean;
  /** Version recorded after this update (== the running package version). */
  version: string;
}

/**
 * Merge path (file has a well-formed prompt block): replace the block with the
 * template's version and refresh the stamp. Content outside the markers is
 * preserved line-by-line. Hand-edit detection: the recorded stamp hash no
 * longer matches the block on disk.
 */
export function updateManagedScaffold(
  existing: string,
  templateText: string,
  pkgVersion: string,
): ScaffoldUpdate {
  const tplLines = extractBlockContent(templateText);
  const tplHash = hashBlock(tplLines.join("\n"));
  const stamp = parseStamp(existing);

  const oldContent = extractBlockContent(existing);
  const handEdited = stamp?.hash != null && hashBlock(oldContent.join("\n")) !== stamp.hash;

  const lines = existing.split(/\r?\n/);
  const found = findPromptBlock(lines);
  if (!found.span) throw new Error("malformed mycastle-prompt markers");
  const rebuilt = [
    ...lines.slice(0, found.span.begin),
    PROMPT_BEGIN,
    ...tplLines,
    PROMPT_END,
    ...lines.slice(found.span.end + 1),
  ];
  let text = rebuilt.join("\n");

  const newStamp = buildStamp(pkgVersion, tplHash);
  text = STAMP_TOKEN_RE.test(text)
    ? text.replace(STAMP_TOKEN_RE, newStamp)
    : text.replace(/^(#[^\n]*\n)/, `$1${newStamp}\n`);

  const changed = text.replace(/\r\n/g, "\n") !== existing.replace(/\r\n/g, "\n");
  return { text, changed, handEdited, version: pkgVersion };
}

/**
 * Migration path (legacy scaffold, no markers): rebuild from the template,
 * preserving the user's External-repos notes. The caller always backs up the
 * original before writing — this is the only full-file rewrite.
 */
export function migrateLegacyScaffold(
  existing: string,
  templateText: string,
  pkgVersion: string,
): ScaffoldUpdate {
  const tplLines = extractBlockContent(templateText);
  const tplHash = hashBlock(tplLines.join("\n"));
  let text = templateText.replace(
    STAMP_TOKEN_RE,
    buildStamp(pkgVersion, tplHash),
  );
  const userBody = extractExternalRepos(existing);
  if (userBody) text = spliceExternalRepos(text, userBody);
  return { text, changed: true, handEdited: false, version: pkgVersion };
}

/** Fresh scaffold write (init): stamp the template as-is. */
export function stampFreshScaffold(templateText: string, pkgVersion: string): string {
  const tplLines = extractBlockContent(templateText);
  const tplHash = hashBlock(tplLines.join("\n"));
  return templateText.replace(STAMP_TOKEN_RE, buildStamp(pkgVersion, tplHash));
}
