// jenkins.ts — thin CLI over src/lib/jenkins-client.js.
//
//   mycastle jenkins <command> [args] [options]
//
// Read-only commands (default posture):
//   envs                   list configured envs: name + url + auth kind (never apiToken)
//   status                 instance summary: version, quietingDown, job/view counts
//   jobs                   job list (top level; --depth walks into folders)
//   job <name>             one job's details (health, last builds, parameters)
//   builds <name> [-n N]   build history, newest first
//   build <name> [<ref>]   one build's details incl. parameters (default lastBuild)
//   log <name> [<ref>]     build log via progressiveText (--console/--follow/--tail)
//   queue                  queued items
//   nodes                  nodes + executor slots
//   views                  view names
//   whoami                 identity probe (auth self-check)
//   get <path>             GET any read endpoint, e.g. "/queue/item/42/api/json"
//
// Writes (opt-in, need --yes; without it they print a dry-run payload):
//   trigger <name> [--param k=v]...   queue a build
//   stop <name> [<ref>]               abort a build
//
// Target precedence: --url flag > .myws/jenkins.config.json (per-env
// url/basePath/username/apiToken) > env vars (JENKINS_URL + JENKINS_USERNAME/
// JENKINS_API_TOKEN). Secrets never touch argv.
//
// API reference: https://www.jenkins.io/doc/book/using/remote-access-api/

import process from "node:process";
import { BUILD_ALIASES, JenkinsClient, type JenkinsJobNode } from "./lib/jenkins-client.js";
import {
  configExists,
  listEnvs,
  loadJenkinsConfig,
  resolveEnvs,
  toClientOptions,
} from "./lib/jenkins-config.js";
import { redactUrlCredentials } from "./lib/redact.js";

interface CliArgs {
  rest: string[]; // positional: command + its args
  url?: string;
  basePath?: string;
  timeoutMs?: number;
  env?: string;
  configPath?: string;
  compact: boolean;
  help: boolean;
  raw: boolean;
  yes: boolean;
  // list options
  view?: string;
  filter?: string;
  status?: string;
  depth?: number;
  limit?: number;
  // log options
  tail: boolean;
  follow: boolean;
  consoleText: boolean;
  maxChars?: number;
  // trigger options
  params: Record<string, string>;
}

const HELP = `jenkins — Jenkins Remote Access API CLI (JSON to stdout)

Usage:
  mycastle jenkins <command> [args] [options]

Read-only commands:
  envs                      list configured envs (.myws/jenkins.config.json; no secrets)
  status                    instance summary: version, quietingDown, job/view counts
  jobs [--view v]           job list; --depth <n> walks into folders (default 1)
       [--filter s]         substring match on full name ("folder/sub")
       [--status c]         base color filter: blue|red|yellow|grey|notbuilt|
                            disabled|aborted|building (suffix "_anime")
       [-n N]               cap the returned list
  job <name>                one job's details: health, last builds, parameters
                            (nested jobs are "folder/sub")
  builds <name> [-n N]      build history, newest first (default N=20)
  build <name> [<ref>]      one build's details incl. parameters; <ref> is a
                            number or alias (default lastBuild)
  log <name> [<ref>]        build log (default lastBuild):
       --console            whole log via consoleText (clean, one response)
       --tail               keep pulling progressiveText to the end
       --follow             keep polling while the build is running (Ctrl-C ends)
       --max <chars>        keep the LAST <chars> characters (default 200000; 0 = all)
  queue                     items waiting in the build queue
  nodes                     nodes (incl. Built-In) + executor slots
  views                     view names
  whoami                    identity probe — use first to verify credentials
  get <path>                GET any read endpoint, e.g. "/queue/item/42/api/json"

Write commands (opt-in; without --yes they only print what WOULD be sent):
  trigger <name> [--param k=v]... [--yes]
                            queue a build (buildWithParameters when params given)
  stop <name> [<ref>] [--yes]
                            abort a build

Options:
  --env <name|all|a,b>   target env(s) from .myws/jenkins.config.json;
                         default = config "default" or first env
  --config <path>        override .myws/jenkins.config.json
  --url <u>              bypass the config file and target this URL
  --base-path <p>        context path when behind a reverse proxy (e.g. "/jenkins")
  --timeout <ms>         override HTTP timeout (default 30000)
  --raw                  print the untouched API JSON where shaping applies
  --compact              single-line JSON (default: pretty)
  -h, --help             show this help

Target precedence: --url > .myws/jenkins.config.json > env vars (JENKINS_URL +
JENKINS_USERNAME/JENKINS_API_TOKEN for the quick mode). Auth is Basic with an
API token (create one under <jenkins>/me/security/); it is sent preemptively —
Jenkins answers 403 (never 401) for missing credentials — and is CSRF-exempt,
so no crumb handling is needed.

Config mode output is keyed by env name: {"<env>": <result>}; a failing env
yields {"<env>": {"error": "..."}} without interrupting the others.

Job names with folders use "/" — job "team/service" maps to /job/team/job/service/.
`;

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    rest: [],
    compact: false,
    help: false,
    raw: false,
    yes: false,
    tail: false,
    follow: false,
    consoleText: false,
    params: {},
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
      case "--url":
        a.url = next();
        break;
      case "--base-path":
        a.basePath = next();
        break;
      case "--timeout": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n < 1) throw new Error("--timeout must be a positive integer");
        a.timeoutMs = n;
        break;
      }
      case "--env":
        a.env = next();
        break;
      case "--config":
        a.configPath = next();
        break;
      case "--compact":
        a.compact = true;
        break;
      case "--raw":
        a.raw = true;
        break;
      case "--yes":
        a.yes = true;
        break;
      // --- list options ---
      case "--view":
        a.view = next();
        break;
      case "--filter":
        a.filter = next();
        break;
      case "--status":
        a.status = next();
        break;
      case "--depth": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n < 1 || n > 5) throw new Error("--depth must be 1..5");
        a.depth = n;
        break;
      }
      case "-n":
      case "--limit": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n < 1) throw new Error("-n/--limit must be a positive integer");
        a.limit = n;
        break;
      }
      // --- log options ---
      case "--tail":
        a.tail = true;
        break;
      case "--follow":
        a.follow = true;
        break;
      case "--console":
        a.consoleText = true;
        break;
      case "--max": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n < 0) throw new Error("--max must be a non-negative integer");
        a.maxChars = n;
        break;
      }
      // --- trigger options ---
      case "--param": {
        const kv = next();
        const eq = kv.indexOf("=");
        if (eq <= 0) throw new Error(`--param expects k=v, got: "${kv}"`);
        a.params[kv.slice(0, eq)] = kv.slice(eq + 1);
        break;
      }
      default:
        a.rest.push(arg);
    }
  }
  return a;
}

function buildClient(a: CliArgs): JenkinsClient {
  // fromEnv() is the single source of env-parsing truth; apply non-secret overrides.
  if (a.url) process.env.JENKINS_URL = a.url;
  if (a.basePath) process.env.JENKINS_BASE_PATH = a.basePath;
  if (a.timeoutMs) process.env.JENKINS_TIMEOUT_MS = String(a.timeoutMs);
  return JenkinsClient.fromEnv();
}

function print(value: unknown, compact: boolean): void {
  console.log(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

// --- shaping helpers ---------------------------------------------------------

/** Unix-ms timestamp -> ISO 8601 (null when absent). */
function iso(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** "red_anime" -> { color: "red", building: true }. */
function parseColor(color: unknown): { color: string | null; building: boolean } {
  if (typeof color !== "string") return { color: null, building: false };
  const building = color.endsWith("_anime");
  return { color: building ? color.slice(0, -"_anime".length) : color, building };
}

/** Validate a build ref: build number or one of the lastXxx aliases. */
function buildRef(raw: string | undefined): string {
  const ref = raw ?? "lastBuild";
  if (/^\d+$/.test(ref) || (BUILD_ALIASES as readonly string[]).includes(ref)) return ref;
  throw new Error(
    `build ref must be a number or one of: ${BUILD_ALIASES.join(", ")} (got "${ref}")`,
  );
}

/** Flatten nested folder jobs into {fullName, ...} rows. */
function flattenJobs(items: JenkinsJobNode[], prefix: string, out: Record<string, unknown>[]): void {
  for (const j of items) {
    const { jobs, lastBuild, color, name, url, ...rest } = j;
    const fullName = prefix ? `${prefix}/${name ?? ""}` : (name ?? "");
    const { color: base, building } = parseColor(color);
    const row: Record<string, unknown> = {
      fullName,
      color: base,
      building,
      ...(url ? { url } : {}),
      ...(lastBuild?.number !== undefined
        ? {
            lastBuild: {
              number: lastBuild.number,
              timestamp: iso(lastBuild.timestamp),
              result: lastBuild.result ?? (lastBuild.building ? "BUILDING" : null),
            },
          }
        : {}),
      ...rest,
    };
    out.push(row);
    if (jobs?.length) flattenJobs(jobs, fullName, out);
  }
}

/** Extract parameters and causes from a build detail's actions array. */
function shapeBuildActions(
  build: Record<string, unknown>,
): { parameters: unknown[]; causes: unknown[] } {
  const parameters: unknown[] = [];
  const causes: unknown[] = [];
  const actions = build.actions;
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (!action || typeof action !== "object") continue;
      const a = action as { parameters?: unknown; causes?: unknown };
      if (Array.isArray(a.parameters)) parameters.push(...a.parameters);
      if (Array.isArray(a.causes)) {
        for (const c of a.causes) {
          if (c && typeof c === "object") {
            const { shortDescription } = c as { shortDescription?: string };
            if (shortDescription) causes.push(shortDescription);
          }
        }
      }
    }
  }
  return { parameters, causes };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Pull a build log to its end (progressiveText loop) and optionally keep
 * polling while the build runs. Returns the last `maxChars` characters
 * (0 = unlimited) with a truncatedFront marker.
 */
async function collectLog(
  client: JenkinsClient,
  job: string,
  ref: string,
  opts: { follow: boolean; maxChars: number },
): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  let start = 0;
  let hasMore = true;
  let rounds = 0;
  while (hasMore || opts.follow) {
    const slice = await client.logSlice(job, ref, start);
    chunks.push(slice.text);
    start = slice.size;
    hasMore = slice.hasMore;
    if (hasMore || opts.follow) {
      if (++rounds > 5000) break; // safety valve for runaway follow loops
      if (!hasMore) {
        const b = await client.build(job, ref);
        if (!b.json.building) break;
        await sleep(2000);
      }
    }
  }
  let text = chunks.join("");
  const truncatedFront = opts.maxChars > 0 && text.length > opts.maxChars;
  if (truncatedFront) text = text.slice(-opts.maxChars);
  let result: string | null = null;
  if (opts.follow) {
    const b = await client.build(job, ref);
    result = (b.json.result as string | null) ?? null;
  }
  return {
    job,
    build: ref,
    bytes: start,
    chars: text.length,
    truncatedFront,
    ...(result !== null ? { result } : {}),
    text,
  };
}

/**
 * Run one command against one already-built client.
 * Returns JSON-serializable data, or throws (caller decides how to report it).
 */
async function runCommand(
  command: string,
  cmdArgs: string[],
  args: CliArgs,
  client: JenkinsClient,
): Promise<unknown> {
  switch (command) {
    case "status": {
      const { json, version } = await client.instanceStatus();
      const jobs = json.jobs ?? [];
      const byColor: Record<string, number> = {};
      let building = 0;
      for (const j of jobs) {
        const { color, building: b } = parseColor(j.color);
        if (b) building++;
        const key = color ?? "unknown";
        byColor[key] = (byColor[key] ?? 0) + 1;
      }
      return {
        version,
        quietingDown: json.quietingDown ?? false,
        useSecurity: json.useSecurity,
        primaryView: json.primaryView?.name ?? null,
        viewCount: json.views?.length ?? 0,
        jobCount: jobs.length,
        building,
        jobsByColor: byColor,
      };
    }
    case "jobs": {
      const depth = args.depth ?? 1;
      const { json } = await client.listJobs({ view: args.view, depth });
      const flat: Record<string, unknown>[] = [];
      flattenJobs(json.jobs ?? [], "", flat);
      let rows = flat;
      if (args.filter) {
        const needle = args.filter.toLowerCase();
        rows = rows.filter((r) => String(r.fullName ?? "").toLowerCase().includes(needle));
      }
      if (args.status) {
        const want = args.status;
        rows = rows.filter((r) =>
          want === "building" ? r.building === true : r.color === want,
        );
      }
      const total = rows.length;
      if (args.limit) rows = rows.slice(0, args.limit);
      return {
        ...(args.view ? { view: args.view } : {}),
        depth,
        total,
        returned: rows.length,
        jobs: rows,
      };
    }
    case "job": {
      const [name] = cmdArgs;
      if (!name) throw new Error("usage: job <name>  (nested jobs: folder/sub)");
      const { json } = await client.job(name);
      const j = json as Record<string, unknown>;
      const health = Array.isArray(j.healthReport)
        ? (j.healthReport as { score?: number; description?: string }[]).map((h) => ({
            score: h.score ?? null,
            description: h.description ?? null,
          }))
        : [];
      const parameters = Array.isArray(j.property)
        ? (j.property as { parameterDefinitions?: unknown[] }[])
            .flatMap((p) => (Array.isArray(p.parameterDefinitions) ? p.parameterDefinitions : []))
            .map((d) => {
              const def = d as {
                name?: string;
                type?: string;
                defaultParameterValue?: { value?: unknown };
                choices?: unknown;
              };
              return {
                name: def.name ?? null,
                type: def.type ?? null,
                default: def.defaultParameterValue?.value ?? null,
                ...(def.choices !== undefined ? { choices: def.choices } : {}),
              };
            })
        : [];
      const { color, building } = parseColor(j.color);
      const lastBuild = j.lastBuild as Record<string, unknown> | undefined;
      const lastSuccess = j.lastSuccessfulBuild as Record<string, unknown> | undefined;
      const lastCompleted = j.lastCompletedBuild as Record<string, unknown> | undefined;
      return {
        name: j.name ?? null,
        displayName: j.displayName ?? null,
        fullName: name,
        description: j.description ?? null,
        color,
        building,
        inQueue: j.inQueue,
        health,
        parameters,
        lastBuild: lastBuild
          ? {
              number: lastBuild.number ?? null,
              timestamp: iso(lastBuild.timestamp),
              result: lastBuild.result ?? (lastBuild.building ? "BUILDING" : null),
              durationMs: lastBuild.duration ?? null,
            }
          : null,
        lastSuccessfulBuild: lastSuccess
          ? { number: lastSuccess.number ?? null, timestamp: iso(lastSuccess.timestamp) }
          : null,
        lastCompletedBuild: lastCompleted
          ? {
              number: lastCompleted.number ?? null,
              timestamp: iso(lastCompleted.timestamp),
              result: lastCompleted.result ?? null,
            }
          : null,
      };
    }
    case "builds": {
      const [name] = cmdArgs;
      if (!name) throw new Error("usage: builds <name> [-n N]");
      const limit = args.limit ?? 20;
      const { builds: history } = await client.builds(name, limit);
      const builds = (history ?? []).map((b) => ({
        number: b.number ?? null,
        timestamp: iso(b.timestamp),
        result: b.result ?? (b.building ? "BUILDING" : null),
        durationMs: b.duration ?? null,
        building: b.building ?? false,
      }));
      return { job: name, requested: limit, returned: builds.length, builds };
    }
    case "build": {
      const [name, refArg] = cmdArgs;
      if (!name) throw new Error(`usage: build <name> [<n>|${BUILD_ALIASES.join("|")}]`);
      const ref = buildRef(refArg);
      const { json } = await client.build(name, ref);
      const b = json as Record<string, unknown>;
      const { parameters, causes } = shapeBuildActions(b);
      return {
        job: name,
        ref,
        number: b.number ?? null,
        result: b.result ?? (b.building ? "BUILDING" : null),
        building: b.building,
        timestamp: iso(b.timestamp),
        durationMs: b.duration ?? null,
        builtOn: b.builtOn ?? null,
        url: b.url ?? null,
        causes,
        parameters,
        ...(args.raw ? { raw: b } : {}),
      };
    }
    case "log": {
      const [name, refArg] = cmdArgs;
      if (!name) throw new Error("usage: log <name> [<n>|lastBuild] [--console|--tail|--follow]");
      const ref = buildRef(refArg);
      if (args.consoleText) {
        const text = await client.consoleText(name, ref);
        const max = args.maxChars ?? 200000;
        const truncatedFront = max > 0 && text.length > max;
        return {
          job: name,
          build: ref,
          chars: text.length,
          truncatedFront,
          ...(truncatedFront ? { text: text.slice(-max) } : { text }),
        };
      }
      return collectLog(client, name, ref, {
        follow: args.follow,
        maxChars: args.maxChars ?? 200000,
      });
    }
    case "queue": {
      const { json } = await client.queue();
      const items = json.items ?? [];
      return { count: items.length, items };
    }
    case "nodes": {
      const { json } = await client.nodes();
      const computer = json.computer ?? [];
      return {
        count: computer.length,
        nodes: computer,
      };
    }
    case "views": {
      const { json } = await client.views();
      const views = (json.views ?? []).map((v) => v.name ?? "").filter(Boolean);
      return { count: views.length, views };
    }
    case "whoami": {
      const { json } = await client.whoami();
      return json;
    }
    case "get": {
      const [path] = cmdArgs;
      if (!path) throw new Error('usage: get <path>  e.g. "/queue/item/42/api/json"');
      if (!path.startsWith("/")) throw new Error("get <path> must start with /");
      const { json } = await client.get(path);
      return json;
    }
    case "trigger": {
      const [name] = cmdArgs;
      if (!name) throw new Error("usage: trigger <name> [--param k=v]... [--yes]");
      if (!args.yes) {
        return {
          job: name,
          params: args.params,
          dryRun: true,
          hint: "add --yes to queue this build",
        };
      }
      const { status, location } = await client.trigger(name, args.params);
      const queueId = location?.match(/queue\/item\/(\d+)/)?.[1] ?? null;
      return {
        job: name,
        params: args.params,
        queued: true,
        status,
        queueId,
        ...(location ? { queueLocation: location } : {}),
      };
    }
    case "stop": {
      const [name, refArg] = cmdArgs;
      if (!name) throw new Error(`usage: stop <name> [<n>|${BUILD_ALIASES.join("|")}] [--yes]`);
      const ref = buildRef(refArg);
      if (!args.yes) {
        return {
          job: name,
          build: ref,
          dryRun: true,
          hint: "add --yes to abort this build",
        };
      }
      const { status } = await client.stop(name, ref);
      return { job: name, build: ref, stopAccepted: true, status };
    }
    default:
      throw new Error(`unknown command: ${command}`);
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
  if (args.help || args.rest.length === 0) {
    console.log(HELP);
    return;
  }

  const [command = "", ...cmdArgs] = args.rest;
  // Validate the command before touching any config, so a typo'd command isn't
  // masked by a config/JENKINS_URL error on first run.
  const known = new Set([
    "envs",
    "status",
    "jobs",
    "job",
    "builds",
    "build",
    "log",
    "queue",
    "nodes",
    "views",
    "whoami",
    "get",
    "trigger",
    "stop",
  ]);
  if (!known.has(command)) {
    console.error(HELP);
    console.error(`error: unknown command: ${command}`);
    process.exit(2);
  }

  // "envs" lists names + redacted url + auth KIND — no live connection; the
  // apiToken is never printed (username is, matching the other tools' envs).
  if (command === "envs") {
    try {
      const listing = listEnvs(loadJenkinsConfig({ configPath: args.configPath }));
      const names = listing.envs.map((e) => e.name);
      const def = listing.default && names.includes(listing.default) ? listing.default : (names[0] ?? null);
      print(
        {
          default: def,
          envs: listing.envs.map((e) => ({
            name: e.name,
            url: redactUrlCredentials(e.url),
            basePath: e.basePath,
            auth: e.auth,
            username: e.username,
            isDefault: e.name === def,
          })),
        },
        args.compact,
      );
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    return;
  }

  // Resolve the target(s): --url flag > config file > env vars.
  const hasConfig = configExists({ configPath: args.configPath });
  const legacyMode = Boolean(args.url) || (!hasConfig && Boolean(process.env.JENKINS_URL));
  if (!legacyMode && !hasConfig) {
    console.error(
      "error: no Jenkins target configured. Create .myws/jenkins.config.json " +
        '(run "mycastle jenkins --help"), set JENKINS_URL (+ JENKINS_USERNAME/' +
        "JENKINS_API_TOKEN), or pass --url.",
    );
    process.exit(1);
  }

  if (legacyMode) {
    // Single target, env-var auth semantics; keeps the historical unkeyed output shape.
    try {
      const client = buildClient(args);
      print(await runCommand(command, cmdArgs, args, client), args.compact);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    return;
  }

  // Config mode: one run per env, results keyed by env name; a failing env
  // yields {"error": ...} without interrupting the others.
  const cfg = loadJenkinsConfig({ configPath: args.configPath });
  const results: Record<string, unknown> = {};
  for (const envName of resolveEnvs(cfg, args.env)) {
    const entry = cfg.envs[envName]!;
    // Non-secret CLI overrides on top of the file entry.
    if (args.basePath) entry.basePath = args.basePath;
    if (args.timeoutMs) entry.timeoutMs = args.timeoutMs;
    try {
      const client = new JenkinsClient(toClientOptions(entry));
      results[envName] = await runCommand(command, cmdArgs, args, client);
    } catch (e) {
      results[envName] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  print(results, args.compact);
}
