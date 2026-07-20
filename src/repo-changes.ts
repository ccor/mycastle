// repo-changes.ts — collect local repo changes since last run, emit structured JSON.
//
// One-shot CLI (schedule it via cron/schtasks). The tool only COLLECTS data;
// an agent reads this JSON and writes the summary. No LLM lives in this tool.
//
//   mycastle changes [options]
//
//   --config <path>        repo list config (default: .myws/repos.config.json)
//   --repo <path|name>     run a single repo (overrides config)
//   --since <ref|1d|date>  stateless window instead of stored baseline
//   --max-count <n>        commits on first run / when no baseline (default: 1)
//   --no-fetch             skip best-effort 'git fetch'
//   --no-author            omit commit author from output
//   --with-diff            include full diff text per repo
//   --dry-run              do not advance the stored baseline
//   --format json|text     output format (default: json)

import path from "node:path";
import { loadReposConfig } from "./lib/repos-config.js";
import { readState, stateKey, writeState } from "./lib/state.js";
import { collectRepoChanges, type RepoChanges } from "./lib/git-collect.js";

interface CliArgs {
  config: string;
  repo?: string;
  since?: string;
  maxCount: number;
  fetch: boolean;
  withAuthor: boolean;
  withDiff: boolean;
  dryRun: boolean;
  format: "json" | "text";
  help: boolean;
}

const HELP = `repo-changes — collect local repo changes since last run (JSON to stdout)

Usage:
  mycastle changes [options]

Options:
  --config <path>        repo list config (default: .myws/repos.config.json)
  --repo <path|name>     run a single repo (overrides config)
  --since <ref|1d|date>  stateless window instead of stored baseline
  --max-count <n>        commits on first run / when no baseline (default: 1)
  --no-fetch             skip best-effort 'git fetch'
  --no-author            omit commit author from output
  --with-diff            include full diff text per repo
  --dry-run              do not advance the stored baseline
  --format json|text     output format (default: json)
  -h, --help             show this help
`;

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    config: ".myws/repos.config.json",
    maxCount: 1,
    fetch: true,
    withAuthor: true,
    withDiff: false,
    dryRun: false,
    format: "json",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "--config":
        a.config = next();
        break;
      case "--repo":
        a.repo = next();
        break;
      case "--since":
        a.since = next();
        break;
      case "--max-count": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n < 1) throw new Error("--max-count must be a positive integer");
        a.maxCount = n;
        break;
      }
      case "--no-fetch":
        a.fetch = false;
        break;
      case "--fetch":
        a.fetch = true;
        break;
      case "--no-author":
        a.withAuthor = false;
        break;
      case "--with-diff":
        a.withDiff = true;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--format": {
        const f = next();
        if (f !== "json" && f !== "text") throw new Error(`--format must be json or text, got "${f}"`);
        a.format = f;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return a;
}

function printText(p: { generatedAt: string; mode: string; repos: RepoChanges[] }): void {
  console.log(`${p.mode} @ ${p.generatedAt}`);
  for (const r of p.repos) {
    console.log(`\n${r.name} [${r.branch}] — ${r.newCount} new commit(s)`);
    if (r.error) {
      console.log(`  ! ${r.error}`);
      continue;
    }
    if (r.fetchError) console.log(`  (fetch failed: ${r.fetchError})`);
    for (const c of r.commits) {
      const who = c.author ? `  ${c.author}` : "";
      console.log(`  ${c.sha.slice(0, 9)}  ${c.date}${who}`);
      console.log(`      ${c.subject}`);
    }
    if (r.diffStat) {
      console.log(`  diff: ${r.diffStat.files} file(s), +${r.diffStat.insertions} -${r.diffStat.deletions}`);
    }
  }
}

export async function run(argv: string[]): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(HELP);
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  const configPath = path.resolve(args.config);
  let repos;
  try {
    repos = loadReposConfig(configPath, args.repo);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }

  const advanceState = !args.dryRun && !args.since;
  const state = readState();

  const results: RepoChanges[] = [];
  for (const entry of repos) {
    const r = await collectRepoChanges(
      entry,
      {
        since: args.since,
        maxCount: args.maxCount,
        fetch: args.fetch,
        withAuthor: args.withAuthor,
        withDiff: args.withDiff,
      },
      (branch) => state[stateKey(entry.name, branch)]?.lastSeen ?? null,
    );
    results.push(r);
    if (advanceState && r.head && !r.error) {
      state[stateKey(entry.name, r.branch)] = { lastSeen: r.head, at: new Date().toISOString() };
    }
  }

  if (advanceState) {
    writeState(state);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    mode: args.since ? ("since" as const) : ("incremental" as const),
    repos: results,
  };

  if (args.format === "text") {
    printText(payload);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
}
