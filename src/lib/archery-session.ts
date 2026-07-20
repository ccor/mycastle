// archery-session.ts — persist Archery Django session tokens per env, under configDir.
// Tokens = { sessionid, csrftoken }; persisting them lets commands reuse the session.

import fs from "node:fs";
import path from "node:path";
import { configDir, ensureDir } from "./platform.js";

export interface SessionRecord {
  sessionid: string; // Django session id
  csrftoken: string; // CSRF token (double-submit: cookie value == X-CSRFTOKEN header)
  at: string; // ISO timestamp of when it was recorded
}

function sessionFile(env: string): string {
  // env names come from config keys; sanitize defensively for the filesystem.
  const safe = env.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(configDir, `archery-session-${safe}.json`);
}

export function readSession(env: string): SessionRecord | undefined {
  try {
    const raw = fs.readFileSync(sessionFile(env), "utf8");
    const rec = JSON.parse(raw) as SessionRecord;
    if (
      typeof rec.sessionid === "string" && rec.sessionid.length > 0 &&
      typeof rec.csrftoken === "string" && rec.csrftoken.length > 0
    ) {
      return rec;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeSession(env: string, sessionid: string, csrftoken: string): void {
  ensureDir(configDir);
  const rec: SessionRecord = { sessionid, csrftoken, at: new Date().toISOString() };
  fs.writeFileSync(sessionFile(env), JSON.stringify(rec, null, 2), "utf8");
}

export function clearSession(env: string): void {
  try {
    fs.unlinkSync(sessionFile(env));
  } catch {
    /* already absent — ignore */
  }
}
