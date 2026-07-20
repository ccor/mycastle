// Cross-platform helpers: keep ALL OS-specific logic here so individual tools
// stay platform-agnostic. Import from a tool at src/<name>.ts via "./lib/platform.js".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Value of `process.platform`: 'win32' | 'darwin' | 'linux' | ... */
export const platform = process.platform;

/** CPU architecture: 'x64' | 'arm64' | ... */
export const arch = os.arch();

export const isWindows = platform === "win32";
export const isMac = platform === "darwin";
export const isLinux = platform === "linux";

/** Human-readable OS label, for logs and CLI output. */
export const platformLabel = isWindows ? "Windows" : isMac ? "macOS" : "Linux";

/**
 * Per-user data/config directory for these tools.
 *   Windows      -> %LOCALAPPDATA%\mycastle
 *   macOS/Linux  -> ~/.config/mycastle
 * Use this for state files, caches, etc. (e.g. the repo-change monitor's
 * "last processed commit" marker).
 */
export const configDir = isWindows
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "mycastle")
  : path.join(os.homedir(), ".config", "mycastle");

/** Create a directory (recursive) if missing; no-op if it already exists. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
