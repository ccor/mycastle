// xxljob-session.ts — persist the XXL_JOB_LOGIN_IDENTITY cookie per env, under configDir.
// The cookie IS the session; persisting it lets commands reuse the session across runs.

import fs from "node:fs";
import path from "node:path";
import { configDir, ensureDir } from "./platform.js";

export interface SessionRecord {
  cookie: string; // value of XXL_JOB_LOGIN_IDENTITY
  at: string; // ISO timestamp of when it was recorded
}

function sessionFile(env: string): string {
  // env names come from config keys; sanitize defensively for the filesystem.
  const safe = env.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(configDir, `xxljob-session-${safe}.json`);
}

export function readSession(env: string): SessionRecord | undefined {
  try {
    const raw = fs.readFileSync(sessionFile(env), "utf8");
    const rec = JSON.parse(raw) as SessionRecord;
    if (typeof rec.cookie === "string" && rec.cookie.length > 0) return rec;
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeSession(env: string, cookie: string): void {
  ensureDir(configDir);
  const rec: SessionRecord = { cookie, at: new Date().toISOString() };
  fs.writeFileSync(sessionFile(env), JSON.stringify(rec, null, 2), "utf8");
}

export function clearSession(env: string): void {
  try {
    fs.unlinkSync(sessionFile(env));
  } catch {
    /* already absent — ignore */
  }
}
