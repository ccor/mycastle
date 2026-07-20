// state.ts — persist the last-seen commit per repo so each run reports only NEW changes.
// Stored under the shared config dir (see platform.js). Keyed by `${name}@${branch}`.

import fs from "node:fs";
import path from "node:path";
import { configDir, ensureDir } from "./platform.js";

export interface RepoState {
  lastSeen: string; // commit SHA
  at: string; // ISO timestamp of when it was recorded
}

export type State = Record<string, RepoState>;

const stateFile = path.join(configDir, "state.json");

export function stateKey(name: string, branch: string): string {
  return `${name}@${branch || "HEAD"}`;
}

export function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
  } catch {
    return {};
  }
}

export function writeState(state: State): void {
  ensureDir(configDir);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}
