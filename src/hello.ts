// hello.ts — verifies the scaffold runs and prints platform info.
// Invoked via: mycastle hello

import { arch, configDir, ensureDir, platform, platformLabel } from "./lib/platform.js";

export function run(_argv: string[] = []): void {
  // Ensure the shared data dir exists (also proves it's writable).
  ensureDir(configDir);

  console.log(`Hello from ${platformLabel} (${platform}/${arch})`);
  console.log(`mycastle data dir: ${configDir}`);
}
