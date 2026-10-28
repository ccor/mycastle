// yapi-session.ts — persist the YApi login session cookies per env, under configDir.
// The cookie pair (_yapi_token JWT + _yapi_uid) IS the session; persisting it lets
// commands reuse the login across runs (JWT valid 7 days per YApi source).

import fs from "node:fs";
import path from "node:path";
import { configDir, ensureDir } from "./platform.js";

export interface YapiSessionRecord {
  /** Raw Cookie header value, e.g. "_yapi_token=...; _yapi_uid=...". */
  cookie: string;
  at: string; // ISO timestamp of when it was recorded
}

function sessionFile(env: string): string {
  // env names come from config keys; sanitize defensively for the filesystem.
  const safe = env.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(configDir, `yapi-session-${safe}.json`);
}

export function readSession(env: string): YapiSessionRecord | undefined {
  try {
    const raw = fs.readFileSync(sessionFile(env), "utf8");
    const rec = JSON.parse(raw) as YapiSessionRecord;
    if (typeof rec.cookie === "string" && rec.cookie.length > 0) return rec;
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeSession(env: string, cookie: string): void {
  ensureDir(configDir);
  const rec: YapiSessionRecord = { cookie, at: new Date().toISOString() };
  fs.writeFileSync(sessionFile(env), JSON.stringify(rec, null, 2), "utf8");
}

export function clearSession(env: string): void {
  try {
    fs.unlinkSync(sessionFile(env));
  } catch {
    /* already absent — ignore */
  }
}
