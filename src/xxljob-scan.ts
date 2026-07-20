// xxljob-scan.ts — offline scan of a Java source root for xxl-job handler declarations.
// Emits structured JSON to stdout (collector contract; the agent summarizes). No xxl-job
// console, no .myws config, no login — pure source analysis.
//
// Forms recognized (filled in across tasks):
//   old API:  @JobHandler("x") | @JobHandler(value = "x") | @JobHandler(value = Cls.CONST)
//   new API:  @XxlJob("x")
//
// Run:
//   mycastle xxljob-scan --root <src-root> [--api old|new|both] [--glob "**/*.java"] [--compact]

import fs from "node:fs";
import path from "node:path";

export interface ScanHit {
  file: string; // path relative to --root, forward slashes
  line: number; // 1-based line of the annotation
  className: string; // class/interface/enum the annotation is on
  package: string; // java package
  handlerName: string | null; // resolved value; null if unresolved constant
  api: "old" | "new"; // @JobHandler (old) | @XxlJob (new)
  valueForm: string; // "literal" | "constant:Cls.CONST" | "unresolved:Cls.CONST" | "unrecognized:<token>"
}

interface Opts {
  root: string;
  api: "old" | "new" | "both";
  glob: string;
  compact: boolean;
  help: boolean;
}

const HELP = `xxljob-scan — offline scan of a Java source root for xxl-job handler declarations (JSON to stdout)

Usage:
  mycastle xxljob-scan --root <src-root> [options]

Options:
  --root <path>        source root to scan recursively (required)
  --api old|new|both   which annotations to scan (default: both)
  --glob <pattern>     file glob, default "**/*.java"
  --compact            single-line JSON (default: pretty)
  -h, --help           show this help

Forms recognized:
  @JobHandler("x") | @JobHandler(value = "x")          old API, literal
  @JobHandler(value = Cls.CONST)                        old API, constant ref (resolved same-file)
  @XxlJob("x")                                          new API, literal

Output JSON array; one object per declaration. valueForm is one of:
  literal | constant:<Cls.CONST> | unresolved:<Cls.CONST> | unrecognized:<token>

No console, no config, no login. Errors/notes go to stderr.`;

function parseArgs(argv: string[]): Opts {
  const o: Opts = { root: "", api: "both", glob: "**/*.java", compact: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help":
        o.help = true;
        break;
      case "--compact":
        o.compact = true;
        break;
      case "--root":
        o.root = argv[++i] ?? "";
        break;
      case "--api": {
        const v = argv[++i];
        if (v !== "old" && v !== "new" && v !== "both") {
          throw new Error(`--api must be old|new|both, got "${v}"`);
        }
        o.api = v;
        break;
      }
      case "--glob":
        o.glob = argv[++i] ?? "";
        break;
      default:
        throw new Error(`unknown argument: ${a} (see --help)`);
    }
  }
  return o;
}

/** Minimal glob → RegExp. Supports ** (any path incl separators), * (non-separator), ? (one non-separator). */
function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++; // eat the trailing '/' of ' **/ '
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+()|[]{}^$\\".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Recursively list files under `root` whose relative path matches `globRe`. Returns forward-slashed rel paths, sorted. */
function listFiles(root: string, globRe: RegExp): string[] {
  const entries = fs.readdirSync(root, { recursive: true });
  const out: string[] = [];
  for (const e of entries) {
    const rel = String(e).split(path.sep).join("/");
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!globRe.test(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

const RE_PACKAGE = /^\s*package\s+([\w.]+)\s*;/m;
// @JobHandler( ... ) — capture the single value argument (after optional `value = `).
// Inner group skips over quoted strings so a `)` inside a literal value (e.g. "a)b") is not
// mistaken for the annotation's close paren. Single-line annotations only.
const RE_JOBHANDLER = /@JobHandler\s*\(\s*(?:value\s*=\s*)?((?:"[^"]*"|[^)])*?)\s*\)/g;
// @XxlJob("x") — new API, literal only
const RE_XXLJOB = /@XxlJob\s*\(\s*"([^"]+)"\s*\)/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 1-based line number of a character index within `text`. */
function lineOf(text: string, charIdx: number): number {
  let line = 1;
  const end = Math.min(charIdx, text.length);
  for (let i = 0; i < end; i++) if (text[i] === "\n") line++;
  return line;
}

/** Name of the first class/interface/enum declared at or after `fromIdx` (the type the annotation is on). */
function classNameAt(text: string, fromIdx: number): string {
  const m = text.slice(fromIdx).match(/\b(?:class|interface|enum)\s+(\w+)/);
  return m ? m[1]! : "";
}

/**
 * Resolve a `<Cls>.<CONST>` handler reference by finding a same-file declaration
 *   (public|private|protected)? static final String <CONST> = "value";
 * Returns the literal value, or null if not found. (The SampleJob.JOB_HANDLER_NAME pattern.)
 */
function resolveConst(text: string, constName: string): string | null {
  const re = new RegExp(
    `(?:public|private|protected)?\\s*static\\s+final\\s+String\\s+${escapeRe(constName)}\\s*=\\s*"([^"]+)"`,
  );
  const m = text.match(re);
  return m ? m[1]! : null;
}

/** Scan one Java file for xxl-job declarations. Literal + same-file constant-ref (@JobHandler(value = Cls.CONST)). */
function scanFile(absPath: string, rel: string, api: Opts["api"]): ScanHit[] {
  const text = fs.readFileSync(absPath, "utf8");
  // Quick reject: skip files that clearly have neither annotation.
  if (!/JobHandler/.test(text) && !/XxlJob/.test(text)) return [];

  const pkgMatch = text.match(RE_PACKAGE);
  const pkg = pkgMatch ? pkgMatch[1]! : "";
  const hits: ScanHit[] = [];

  const wantOld = api !== "new";
  const wantNew = api !== "old";

  if (wantOld) {
    for (const m of text.matchAll(RE_JOBHANDLER)) {
      const token = (m[1] ?? "").trim();
      const idx = m.index ?? 0;
      const lit = token.match(/^"([^"]+)"$/);
      if (lit) {
        hits.push({
          file: rel,
          line: lineOf(text, idx),
          className: classNameAt(text, idx),
          package: pkg,
          handlerName: lit[1]!,
          api: "old",
          valueForm: "literal",
        });
        continue;
      }
      // Non-literal token: try Cls.CONST constant reference (resolved same-file); else record unresolved.
      const cref = token.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
      if (cref) {
        const cls = cref[1]!;
        const constName = cref[2]!;
        const resolved = resolveConst(text, constName);
        hits.push({
          file: rel,
          line: lineOf(text, idx),
          className: classNameAt(text, idx),
          package: pkg,
          handlerName: resolved,
          api: "old",
          valueForm: resolved ? `constant:${cls}.${constName}` : `unresolved:${cls}.${constName}`,
        });
        continue;
      }
      hits.push({
        file: rel,
        line: lineOf(text, idx),
        className: classNameAt(text, idx),
        package: pkg,
        handlerName: null,
        api: "old",
        valueForm: `unrecognized:${token}`,
      });
    }
  }

  if (wantNew) {
    for (const m of text.matchAll(RE_XXLJOB)) {
      const idx = m.index ?? 0;
      hits.push({
        file: rel,
        line: lineOf(text, idx),
        className: classNameAt(text, idx),
        package: pkg,
        handlerName: m[1]!,
        api: "new",
        valueForm: "literal",
      });
    }
  }

  return hits;
}

export function run(argv: string[]): void {
  let o: Opts;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message + "\n\n" + HELP);
    process.exit(1);
  }
  if (o.help) {
    console.log(HELP);
    return;
  }
  if (!o.root) {
    console.error("--root is required.\n\n" + HELP);
    process.exit(1);
  }
  const absRoot = path.resolve(o.root);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    console.error(`--root not a directory: ${absRoot} (see --help)`);
    process.exit(1);
  }
  const files = listFiles(absRoot, globToRegex(o.glob));
  let hits: ScanHit[] = [];
  let skipped = 0;
  for (const rel of files) {
    try {
      hits = hits.concat(scanFile(path.join(absRoot, rel), rel, o.api));
    } catch {
      skipped++;
    }
  }
  if (hits.length === 0) {
    console.error(
      `note: no xxl-job declarations under ${absRoot} (check --root/--glob/--api); scanned ${files.length} file(s)`,
    );
  }
  if (skipped > 0) console.error(`note: skipped ${skipped} file(s) on read error`);
  console.log(o.compact ? JSON.stringify(hits) : JSON.stringify(hits, null, 2));
}
