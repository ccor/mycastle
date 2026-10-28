// prometheus.ts — thin read-only CLI over src/lib/prometheus-client.js.
//
//   mycastle prometheus <command> [args] [options]
//
// Commands:
//   envs                   list configured envs: name + url + auth kind (never keys/passwords)
//   status                 GET /api/v1/status/buildinfo (connectivity / version probe)
//   query <promql>         instant query at one point in time (default now)
//   range <promql>         range query over a time window (start/end/last + step)
//   series --match <sel>   label sets matching selectors (repeatable match[])
//   labels                 label names, optionally scoped by --match
//   values <label>         values of one label, optionally scoped by --match
//   targets                scrape targets (active + dropped count)
//   get <path>             GET any read endpoint, e.g. "/api/v1/rules"
//
// Target precedence: --url flag > .myws/prometheus.config.json (per-env auth:
// none/basic/apiKey) > env vars (PROMETHEUS_URL + PROMETHEUS_API_KEY or
// PROMETHEUS_USERNAME/PROMETHEUS_PASSWORD). Secrets never touch argv.
//
// API reference: https://prometheus.io/docs/prometheus/latest/querying/api/

import process from "node:process";
import { PrometheusClient, type PromResponse } from "./lib/prometheus-client.js";
import {
  configExists,
  listEnvs,
  loadPrometheusConfig,
  resolveEnvs,
  toClientOptions,
} from "./lib/prometheus-config.js";
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
  // time-window options
  time?: string; // query: unix seconds or ISO 8601
  start?: string;
  end?: string;
  last?: string; // <n>[s|m|h|d], bare digits = seconds
  step?: string; // seconds ("60") or duration ("1m")
  matches: string[]; // repeatable --match
}

const HELP = `prometheus — read-only Prometheus HTTP API CLI (JSON to stdout)

Usage:
  mycastle prometheus <command> [args] [options]

Commands:
  envs                      list configured envs (.myws/prometheus.config.json; no secrets)
  status                    GET /api/v1/status/buildinfo (connectivity / version probe)
  query <promql>            instant query at one point in time (default now)
  range <promql>            range query over a time window
  series --match <sel>      label sets matching selectors (--match repeatable)
  labels                    label names, optionally scoped by --match
  values <label>            values of one label, optionally scoped by --match
  targets                   scrape targets (active list + dropped count)
  get <path>                GET any read endpoint, e.g. "/api/v1/rules"

Time options:
  --time <unix|iso>         (query) evaluation timestamp; default now
  --start <unix|iso>        (range/series) window start
  --end <unix|iso>          (range/series) window end
  --last <n>[s|m|h|d]       (range/series) relative window; bare digits = seconds
  --step <sec|dur>          (range) resolution; default 60 ("60" or "1m")
  --match <selector>        (series/labels/values) repeatable, e.g. 'up{job="java"}'

Window resolution (--start/--end/--last combinable):
  start+end -> [start,end]; start+last -> [start, start+last];
  end+last  -> [end-last, end]; start only -> [start, now];
  neither   -> last 1h for range/series.

Options:
  --env <name|all|a,b>   target env(s) from .myws/prometheus.config.json;
                         default = config "default" or first env
  --config <path>        override .myws/prometheus.config.json
  --url <u>              bypass the config file and target this URL
  --base-path <p>        override basePath (env mode, or on top of the config entry)
  --timeout <ms>         override HTTP timeout (default 30000)
  --raw                  print the untouched HTTP API envelope {status,data,...}
  --compact              single-line JSON (default: pretty)
  -h, --help             show this help

Target precedence: --url > .myws/prometheus.config.json > env vars (PROMETHEUS_URL,
+ PROMETHEUS_API_KEY or PROMETHEUS_USERNAME/PROMETHEUS_PASSWORD for the quick mode).
Config mode auth comes from the file per env ("none" | "basic" | "apiKey" -> Bearer).
Config mode output is keyed by env name: {"<env>": <result>}; a failing env
yields {"<env>": {"error": "..."}} without interrupting the others.

Quote PromQL on the shell: query 'http_server_requests_seconds_count{app="svc"}'
`;

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    rest: [],
    compact: false,
    help: false,
    raw: false,
    matches: [],
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
      // --- time options ---
      case "--time":
        a.time = next();
        break;
      case "--start":
        a.start = next();
        break;
      case "--end":
        a.end = next();
        break;
      case "--last":
        a.last = next();
        break;
      case "--step":
        a.step = next();
        break;
      case "--match":
        a.matches.push(next());
        break;
      default:
        a.rest.push(arg);
    }
  }
  return a;
}

function buildClient(a: CliArgs): PrometheusClient {
  // fromEnv() is the single source of env-parsing truth; apply non-secret overrides.
  if (a.url) process.env.PROMETHEUS_URL = a.url;
  if (a.basePath) process.env.PROMETHEUS_BASE_PATH = a.basePath;
  if (a.timeoutMs) process.env.PROMETHEUS_TIMEOUT_MS = String(a.timeoutMs);
  return PrometheusClient.fromEnv();
}

function print(value: unknown, compact: boolean): void {
  console.log(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

// --- time helpers ----------------------------------------------------------

/** Unix seconds (float ok) or ISO 8601 -> unix seconds. */
function toPromTime(text: string, flag: string): number {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${flag} expects unix seconds or an ISO 8601 date, got: "${text}"`);
  }
  return d.getTime() / 1000;
}

/** "<n>[s|m|h|d]" (bare digits = seconds) -> seconds. */
function parseDurationSec(text: string, flag: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(text);
  const unit = m?.[2] ?? "";
  if (!m) {
    throw new Error(`${flag} expects <n>[s|m|h|d], got: "${text}"`);
  }
  const mult: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
  return Number(m[1]) * mult[unit]!;
}

/**
 * Resolve the window from --start/--end/--last:
 *   start+end -> both; start+last -> end=start+last; end+last -> start=end-last;
 *   start only -> end=now; end only -> start=end-1h; neither -> [now-1h, now].
 */
function resolveWindow(a: CliArgs): { start: number; end: number } {
  const start = a.start ? toPromTime(a.start, "--start") : undefined;
  const end = a.end ? toPromTime(a.end, "--end") : undefined;
  const lastSec = a.last ? parseDurationSec(a.last, "--last") : undefined;
  const now = Date.now() / 1000;
  if (start !== undefined && end !== undefined) return { start, end };
  if (start !== undefined && lastSec !== undefined) return { start, end: start + lastSec };
  if (end !== undefined && lastSec !== undefined) return { start: end - lastSec, end };
  if (start !== undefined) return { start, end: now };
  if (end !== undefined) return { start: end - 3600, end };
  const span = lastSec ?? 3600;
  return { start: now - span, end: now };
}

// --- shaping ---------------------------------------------------------------

/**
 * Trim the query/range envelope to the useful parts (collector output; --raw for everything).
 * Warnings are surfaced — Prometheus emits query hints there.
 */
function shapeQueryResult(
  envelope: PromResponse<unknown>,
  meta: Record<string, unknown>,
  raw: boolean,
): unknown {
  if (raw) return envelope;
  const data = envelope.data as { resultType?: string; result?: unknown } | undefined;
  const out: Record<string, unknown> = {
    ...meta,
    resultType: data?.resultType,
    result: data?.result,
  };
  if (envelope.warnings?.length) out.warnings = envelope.warnings;
  return out;
}

/** Trim /targets: keep activeTargets in full, collapse droppedTargets to a count. */
function shapeTargets(envelope: PromResponse<unknown>, raw: boolean): unknown {
  if (raw) return envelope;
  const data = envelope.data as {
    activeTargets?: unknown[];
    droppedTargets?: unknown[];
    droppedTargetsCounts?: Record<string, number>;
  } | null;
  const out: Record<string, unknown> = {
    activeTargets: data?.activeTargets ?? [],
    droppedTargetsCount: data?.droppedTargets?.length ?? 0,
  };
  if (data?.droppedTargetsCounts) out.droppedTargetsCounts = data.droppedTargetsCounts;
  return out;
}

/**
 * Run one command against one already-built client.
 * Returns JSON-serializable data, or throws (caller decides how to report it).
 */
async function runCommand(
  command: string,
  cmdArgs: string[],
  args: CliArgs,
  client: PrometheusClient,
): Promise<unknown> {
  switch (command) {
    case "status":
      return args.raw ? await client.buildinfo() : (await client.buildinfo()).data;
    case "query": {
      const [promql] = cmdArgs;
      if (!promql) throw new Error("usage: query <promql>");
      const time = args.time ? toPromTime(args.time, "--time") : undefined;
      const envelope = await client.query(promql, time);
      return shapeQueryResult(
        envelope,
        { query: promql, ...(time !== undefined ? { time } : {}) },
        args.raw,
      );
    }
    case "range": {
      const [promql] = cmdArgs;
      if (!promql) throw new Error("usage: range <promql> [--last 1h | --start .. --end ..] [--step 60]");
      const window = resolveWindow(args);
      const step = args.step ?? "60";
      const envelope = await client.queryRange(promql, { ...window, step });
      return shapeQueryResult(envelope, { query: promql, ...window, step }, args.raw);
    }
    case "series": {
      if (args.matches.length === 0) throw new Error("usage: series --match '<selector>' [--match ...]");
      const window = resolveWindow(args);
      const series = await client.series(args.matches, window);
      return args.raw
        ? series
        : { match: args.matches, start: window.start, end: window.end, series: series.data };
    }
    case "labels": {
      const envelope = await client.labels(args.matches, resolveWindow(args));
      return args.raw ? envelope : envelope.data;
    }
    case "values": {
      const [label] = cmdArgs;
      if (!label || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) {
        throw new Error("usage: values <label-name> [--match '<selector>']");
      }
      const envelope = await client.labelValues(label, args.matches, resolveWindow(args));
      return args.raw ? envelope : envelope.data;
    }
    case "targets":
      return shapeTargets(await client.targets(), args.raw);
    case "get": {
      const [path] = cmdArgs;
      if (!path) throw new Error("usage: get <path>  e.g. /api/v1/rules");
      const envelope = await client.get(path);
      return args.raw ? envelope : envelope.data;
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
  // masked by a config/PROMETHEUS_URL error on first run.
  const known = new Set([
    "envs",
    "status",
    "query",
    "range",
    "series",
    "labels",
    "values",
    "targets",
    "get",
  ]);
  if (!known.has(command)) {
    console.error(HELP);
    console.error(`error: unknown command: ${command}`);
    process.exit(2);
  }

  // "envs" lists names + redacted url + auth KIND — no live connection; keys,
  // usernames and passwords are never printed.
  if (command === "envs") {
    try {
      const listing = listEnvs(loadPrometheusConfig({ configPath: args.configPath }));
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
  const legacyMode = Boolean(args.url) || (!hasConfig && Boolean(process.env.PROMETHEUS_URL));
  if (!legacyMode && !hasConfig) {
    console.error(
      "error: no Prometheus target configured. Create .myws/prometheus.config.json " +
        '(run "mycastle prometheus --help"), set PROMETHEUS_URL (+ PROMETHEUS_API_KEY or ' +
        "PROMETHEUS_USERNAME/PROMETHEUS_PASSWORD), or pass --url.",
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
  const cfg = loadPrometheusConfig({ configPath: args.configPath });
  const results: Record<string, unknown> = {};
  for (const envName of resolveEnvs(cfg, args.env)) {
    const entry = cfg.envs[envName]!;
    // Non-secret CLI overrides on top of the file entry.
    if (args.basePath) entry.basePath = args.basePath;
    if (args.timeoutMs) entry.timeoutMs = args.timeoutMs;
    try {
      const client = new PrometheusClient(toClientOptions(entry));
      results[envName] = await runCommand(command, cmdArgs, args, client);
    } catch (e) {
      results[envName] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  print(results, args.compact);
}
