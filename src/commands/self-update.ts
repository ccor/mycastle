// self-update.ts — convenience: update the mycastle package (npm). Skills are now
// managed by the `skills` CLI and updated separately via `skills update`.

import process from "node:process";
import { execSync } from "node:child_process";

const HELP = `mycastle self-update — update the mycastle package

Usage:
  mycastle self-update            npm update -g mycastle
  mycastle self-update --local    npm update mycastle (local install)
  mycastle self-update --help     show this help

Skills are managed by the \`skills\` CLI; update them separately with: skills update
`;

export async function run(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const local = argv.includes("--local");
  const target = local ? "mycastle" : "-g mycastle";
  console.log(`Updating mycastle (npm update ${target}) ...`);
  try {
    execSync(`npm update ${target}`, { stdio: "inherit" });
  } catch {
    console.error(`Failed to run "npm update ${target}". Update manually.`);
    process.exit(1);
  }
  console.log("\nself-update complete.");
}
