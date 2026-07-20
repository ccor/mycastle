// git-collect.ts — collect new commits + diffstat for one repo via simple-git.
// Pure data collection; NO summarization (an agent turns this JSON into prose).

import simpleGit from "simple-git";
import type { SimpleGit } from "simple-git";

export interface CommitInfo {
  sha: string;
  date: string; // ISO author date (%aI)
  author: string | null; // null when --no-author
  subject: string;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  filesChanged: string[];
}

export interface RepoChanges {
  name: string;
  path: string;
  branch: string;
  fetched: boolean;
  fetchError: string | null;
  error: string | null; // fatal per-repo error (e.g. not a repo)
  lastSeen: string | null; // stored baseline used this run (null on first run / --since)
  head: string | null; // current HEAD SHA
  newCount: number;
  commits: CommitInfo[];
  diffStat: DiffStat | null;
  diff: string | null; // only when opts.withDiff
}

export interface CollectOptions {
  since?: string; // a ref/sha, or a date/duration (1d, 2h, ISO date)
  maxCount: number; // commits to report on first run (no baseline yet)
  fetch: boolean; // best-effort `git fetch` before collecting
  withAuthor: boolean;
  withDiff: boolean;
}

// Exact fields we ask git for (avoids relying on the default subject+decoration format).
// NOTE: commit body is intentionally omitted in v1 (needs multiLine parsing); easy to add.
const LOG_FORMAT = {
  hash: "%H",
  date: "%aI",
  subject: "%s",
  author_name: "%an",
};

/**
 * Collect changes for one repo.
 * @param getBaseline given the current branch, returns the last-seen SHA (or null).
 */
export async function collectRepoChanges(
  entry: { name: string; path: string },
  opts: CollectOptions,
  getBaseline: (branch: string) => string | null,
): Promise<RepoChanges> {
  const out: RepoChanges = {
    name: entry.name,
    path: entry.path,
    branch: "",
    fetched: false,
    fetchError: null,
    error: null,
    lastSeen: null,
    head: null,
    newCount: 0,
    commits: [],
    diffStat: null,
    diff: null,
  };

  const git = simpleGit(entry.path);

  if (!(await isRepo(git))) {
    out.error = "not a git repository";
    return out;
  }

  try {
    try {
      const b = await git.branch();
      out.branch = b.current || (b.detached ? "HEAD" : "");
    } catch {
      out.branch = "";
    }

    out.head = await safeRaw(git, ["rev-parse", "HEAD"]);

    if (opts.fetch) {
      try {
        await git.fetch();
        out.fetched = true;
      } catch (e) {
        out.fetchError = errMsg(e);
      }
    }

    // Resolve a baseline `from` (for `${from}..HEAD`). First run has none.
    const lastSeen = getBaseline(out.branch);
    out.lastSeen = opts.since ? null : lastSeen;

    let from: string | null;
    if (opts.since) {
      from = await resolveSince(git, opts.since);
    } else if (lastSeen) {
      from = lastSeen;
    } else {
      // First run: strictly the newest `maxCount` commits (capped, even with merges).
      const logRes = await git.log({ maxCount: opts.maxCount, format: LOG_FORMAT });
      out.commits = mapLog(logRes, opts.withAuthor);
      const oldest = logRes.all[logRes.all.length - 1]?.hash;
      from = oldest && oldest !== out.head ? oldest : null; // diff span for these commits
    }

    // Incremental / --since: load the commits in `${from}..HEAD`.
    if ((opts.since || lastSeen) && from && from !== out.head) {
      const logRes = await git.log({ from, to: "HEAD", format: LOG_FORMAT });
      out.commits = mapLog(logRes, opts.withAuthor);
    }

    out.newCount = out.commits.length;

    const range = from && from !== out.head ? `${from}..HEAD` : null;
    if (range) {
      const d = await git.diffSummary([range]);
      out.diffStat = {
        files: d.changed,
        insertions: d.insertions,
        deletions: d.deletions,
        filesChanged: d.files.map((f) => f.file),
      };
      if (opts.withDiff) {
        out.diff = await git.diff([range]);
      }
    }
  } catch (e) {
    out.error = errMsg(e);
  }

  return out;
}

// --- helpers ---

function mapLog<T extends { hash: string; date: string; subject?: string; author_name?: string }>(
  logRes: { all: ReadonlyArray<T> },
  withAuthor: boolean,
): CommitInfo[] {
  return logRes.all.map((c) => ({
    sha: c.hash,
    date: c.date,
    author: withAuthor ? (c.author_name ?? null) : null,
    subject: (c.subject ?? "").trim(),
  }));
}

async function isRepo(git: SimpleGit): Promise<boolean> {
  try {
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

/** Run a git command, returning trimmed stdout or null on failure. */
async function safeRaw(git: SimpleGit, args: string[]): Promise<string | null> {
  try {
    const out = await git.raw(args);
    const t = out.trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Resolve a --since value to a baseline SHA: a ref/sha, or the latest commit before a date. */
async function resolveSince(git: SimpleGit, value: string): Promise<string | null> {
  const rev = await safeRaw(git, ["rev-parse", "--verify", value]); // ref / sha?
  if (rev) return rev;
  const when = translateDuration(value); // date / duration
  return safeRaw(git, ["rev-list", "--max-count=1", `--before=${when}`, "HEAD"]);
}

const DURATION_UNITS: Record<string, string> = {
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
  M: "month",
  y: "year",
};

function translateDuration(v: string): string {
  const match = /^(\d+)\s*([smhdwMy])$/.exec(v.trim());
  if (!match) return v; // pass through: git parses ISO dates, "2 days ago", etc.
  const n = match[1]!;
  const unit = DURATION_UNITS[match[2]!];
  if (!unit) return v;
  return `${n} ${unit}${n === "1" ? "" : "s"} ago`;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
