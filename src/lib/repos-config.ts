// repos-config.ts — load + validate the repo-monitor config (a stable subset of repos).
// Path resolution: absolute paths are used as-is; relative paths resolve against `root`
// (then cwd). The real config (.myws/repos.config.json) is gitignored because it holds
// machine-specific absolute paths; only the .example is scaffolded by `mycastle init`.

import fs from "node:fs";
import path from "node:path";

export interface RepoEntry {
  name: string;
  path: string; // absolute, resolved
}

interface RawConfig {
  root?: string;
  repos?: Array<{ name: string; path: string }>;
}

function resolveRepoPath(rawPath: string, root: string | undefined): string {
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(root ?? process.cwd(), rawPath);
}

function readRaw(configPath: string): RawConfig {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as RawConfig;
}

/**
 * Load repos from the config file. When `overrideRepo` is given, a single repo is
 * returned instead: it may be a name configured in the file, an absolute path, or a
 * path relative to `root`/cwd. `overrideRepo` works even when the config is absent.
 */
export function loadReposConfig(configPath: string, overrideRepo?: string): RepoEntry[] {
  let raw: RawConfig | undefined;
  if (overrideRepo) {
    try {
      raw = readRaw(configPath);
    } catch {
      // OK: --repo with an absolute path needs no config file.
    }
  } else {
    try {
      raw = readRaw(configPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Cannot read repo config at ${configPath} (${msg}). ` +
          `Run "mycastle init" to scaffold .myws/repos.config.json, or copy .myws/repos.config.example.json.`,
      );
    }
  }

  const root = raw?.root ? path.resolve(raw.root) : undefined;
  const rawRepos = raw?.repos ?? [];

  if (overrideRepo) {
    const matched = rawRepos.find((r) => r?.name === overrideRepo);
    if (matched) return [{ name: matched.name, path: resolveRepoPath(matched.path, root) }];
    const abs = path.isAbsolute(overrideRepo) ? overrideRepo : resolveRepoPath(overrideRepo, root);
    return [{ name: path.basename(abs), path: abs }];
  }

  if (!Array.isArray(rawRepos) || rawRepos.length === 0) {
    throw new Error(`Config ${configPath} has no "repos". Add at least one entry (see .myws/repos.config.example.json).`);
  }

  return rawRepos.map((r, i) => {
    if (!r || typeof r.name !== "string" || typeof r.path !== "string") {
      throw new Error(`Invalid config entry #${i} in ${configPath}: ${JSON.stringify(r)}`);
    }
    return { name: r.name, path: resolveRepoPath(r.path, root) };
  });
}
