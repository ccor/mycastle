// kibana.ts — thin read-only CLI over src/lib/kibana-client.js.
//
//   mycastle kibana <command> [args] [options]
//
// Commands:
//   envs                   list configured envs: name + url + auth kind (never keys/passwords)
//   status                 GET /api/status (connectivity / auth probe)
//   spaces list            list all spaces
//   spaces get <id>        get one space
//   data-views list        list all data views (index patterns)
//   data-views get <id>    get one data view
//   search                 search logs via a space's Elasticsearch passthrough
//                          (POST /s/<space>/elasticsearch/<index>/_search)
//   get <path>             GET any read endpoint, e.g. "/api/saved_objects/_find?type=dashboard"
//
// Target precedence: --url flag > .myws/kibana.config.json (per-env auth:
// none/apiKey/basic) > env vars (KIBANA_URL + KIBANA_API_KEY or
// KIBANA_USERNAME/KIBANA_PASSWORD). Secrets never touch argv.

import process from "node:process";
import { KibanaClient, type EsSearchResponse } from "./lib/kibana-client.js";
import {
  configExists,
  listEnvs,
  loadKibanaConfig,
  resolveEnvs,
  toClientOptions,
} from "./lib/kibana-config.js";
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
  // `search` command options (also parsed globally; harmless for other commands)
  space?: string;
  index?: string;
  phrases: string[];
  excludes: string[];
  from?: string;
  to?: string;
  last?: string;
  tsField: string;
  size: number;
  order: "asc" | "desc";
  sourceFields?: string[];
  histogram?: string;
  tz: string;
  raw: boolean;
}

const HELP = `kibana — read-only Kibana API CLI (JSON to stdout)

Usage:
  mycastle kibana <command> [args] [options]

Commands:
  envs                   list configured envs: name + url + auth kind (never keys/passwords)
  status                 GET /api/status (connectivity / auth probe)
  spaces list            list all spaces
  spaces get <id>        get one space
  data-views list        list all data views (index patterns)
  data-views get <id>    get one data view
  search                 search logs in a space via Elasticsearch (Discover-equivalent)
  get <path>             GET any read endpoint, e.g. "/api/saved_objects/_find?type=dashboard"

search options:
  --index <pattern>      index pattern, e.g. "my-service*" (required)
  --space <id>           Kibana space id (omit = default space)
  --phrase <text>        phrase filter, repeatable (multi_match type=phrase, lenient)
  --exclude <text>       phrase exclusion, repeatable (bool.must_not)
  --from <iso>           absolute range start, e.g. 2026-09-21T00:00:00+08:00
  --to <iso>             absolute range end
  --last <dur>           relative range <n>s|m|h|d, e.g. 24h (default: 24h when no from/to)
  --ts-field <f>         timestamp field (default @timestamp)
  --size <n>             max hits returned (default 100)
  --order asc|desc       sort direction on the timestamp field (default desc)
  --source-fields <a,b>  restrict _source to these fields
  --histogram <interval> add a date_histogram agg, e.g. 30m (key: "histogram")
  --tz <tz>              time zone for --histogram (default Asia/Shanghai)
  --raw                  print the untouched Elasticsearch response

Options:
  --env <name|all|a,b>  target env(s) from .myws/kibana.config.json;
                        default = config "default" or first env
  --config <path>       override .myws/kibana.config.json
  --url <u>             bypass the config file and target this URL
  --base-path <p>       override basePath (env mode, or on top of the config entry)
  --timeout <ms>        override timeout (env mode, or on top of the config entry)
  --compact             single-line JSON (default: pretty)
  -h, --help            show this help

Target precedence: --url > .myws/kibana.config.json > env vars.
Config mode auth comes from the file per env ("none" | "apiKey" | "basic");
env quick mode reads KIBANA_API_KEY (preferred) or KIBANA_USERNAME + KIBANA_PASSWORD.
Secrets never touch flags. None set = anonymous access (works only if the
instance allows it). Config mode output is keyed by env name:
{"<env>": <result>}; a failing env yields {"<env>": {"error": "..."}}
without interrupting the others.
`;

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    rest: [],
    compact: false,
    help: false,
    phrases: [],
    excludes: [],
    tsField: "@timestamp",
    size: 100,
    order: "desc",
    tz: "Asia/Shanghai",
    raw: false,
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
      // --- search options ---
      case "--space":
        a.space = next();
        break;
      case "--index":
        a.index = next();
        break;
      case "--phrase":
        a.phrases.push(next());
        break;
      case "--exclude":
        a.excludes.push(next());
        break;
      case "--from":
        a.from = next();
        break;
      case "--to":
        a.to = next();
        break;
      case "--last":
        a.last = next();
        break;
      case "--ts-field":
        a.tsField = next();
        break;
      case "--size": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n < 0) throw new Error("--size must be a non-negative integer");
        a.size = n;
        break;
      }
      case "--order": {
        const v = next();
        if (v !== "asc" && v !== "desc") throw new Error(`--order must be asc or desc, got "${v}"`);
        a.order = v;
        break;
      }
      case "--source-fields":
        a.sourceFields = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--histogram":
        a.histogram = next();
        break;
      case "--tz":
        a.tz = next();
        break;
      case "--raw":
        a.raw = true;
        break;
      default:
        a.rest.push(arg);
    }
  }
  return a;
}

function buildClient(a: CliArgs): KibanaClient {
  // fromEnv() is the single source of env-parsing truth; apply non-secret overrides.
  if (a.url) process.env.KIBANA_URL = a.url;
  if (a.basePath) process.env.KIBANA_BASE_PATH = a.basePath;
  if (a.timeoutMs) process.env.KIBANA_TIMEOUT_MS = String(a.timeoutMs);
  return KibanaClient.fromEnv();
}

function print(value: unknown, compact: boolean): void {
  console.log(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

// --- search helpers --------------------------------------------------------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDurationMs(text: string): number {
  const m = /^(\d+)([smhd])$/.exec(text);
  const unit = m?.[2];
  if (!m || !unit) throw new Error(`invalid duration "${text}" (expected <n>s|m|h|d, e.g. 24h)`);
  return Number(m[1]) * UNIT_MS[unit]!;
}

function parseIso(text: string, flag: string): Date {
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error(`${flag} is not a valid date: "${text}"`);
  return d;
}

/**
 * Resolve the time range from --from/--to/--last:
 *   from+to → [from, to]; from+last → [from, from+last]; to+last → [to-last, to];
 *   from|to alone → open-ended on the other side; neither → [now-last, now] (last default 24h).
 */
function resolveTimeRange(a: CliArgs): { gte?: string; lte?: string } {
  const lastMs = a.last ? parseDurationMs(a.last) : undefined;
  const from = a.from ? parseIso(a.from, "--from") : undefined;
  const to = a.to ? parseIso(a.to, "--to") : undefined;
  if (from && to) return { gte: from.toISOString(), lte: to.toISOString() };
  if (from && lastMs !== undefined)
    return { gte: from.toISOString(), lte: new Date(from.getTime() + lastMs).toISOString() };
  if (to && lastMs !== undefined)
    return { gte: new Date(to.getTime() - lastMs).toISOString(), lte: to.toISOString() };
  if (from) return { gte: from.toISOString() };
  if (to) return { lte: to.toISOString() };
  const span = lastMs ?? 24 * 3_600_000;
  return { gte: new Date(Date.now() - span).toISOString(), lte: new Date().toISOString() };
}

/** Phrase filter matching what the Kibana UI emits for quoted terms. */
function phraseQuery(text: string): unknown {
  return { multi_match: { type: "phrase", query: text, lenient: true } };
}

/** Build the ES search body the same way Kibana Discover does (range in must, phrases in filter). */
function buildSearchBody(a: CliArgs): Record<string, unknown> {
  const range = resolveTimeRange(a);
  const body: Record<string, unknown> = {
    version: true,
    size: a.size,
    sort: [{ [a.tsField]: { order: a.order, unmapped_type: "boolean" } }],
    docvalue_fields: [{ field: a.tsField, format: "date_time" }],
    query: {
      bool: {
        ...(range.gte || range.lte
          ? { must: [{ range: { [a.tsField]: { ...range, format: "strict_date_optional_time" } } }] }
          : {}),
        ...(a.phrases.length ? { filter: a.phrases.map(phraseQuery) } : {}),
        ...(a.excludes.length ? { must_not: a.excludes.map(phraseQuery) } : {}),
      },
    },
  };
  if (a.sourceFields?.length) body._source = { includes: a.sourceFields };
  if (a.histogram) {
    body.aggs = {
      histogram: {
        date_histogram: { field: a.tsField, fixed_interval: a.histogram, time_zone: a.tz, min_doc_count: 0 },
      },
    };
  }
  return body;
}

/** Trim the raw ES response to the useful parts (collector output; use --raw for everything). */
function shapeSearchResult(
  raw: EsSearchResponse,
  meta: { space?: string; index: string },
): Record<string, unknown> {
  const hits = raw.hits?.hits ?? [];
  const out: Record<string, unknown> = {
    space: meta.space ?? "(default)",
    index: meta.index,
    took_ms: raw.took,
    timed_out: raw.timed_out ?? false,
    total: raw.hits?.total ?? { value: hits.length, relation: "eq" },
    returned: hits.length,
  };
  if (raw.aggregations) out.aggregations = raw.aggregations;
  out.hits = hits.map((h) => ({ _index: h._index, _id: h._id, _source: h._source }));
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
  client: KibanaClient,
): Promise<unknown> {
  switch (command) {
    case "status":
      return client.status();
    case "spaces": {
      const [sub = "", id] = cmdArgs;
      if (sub === "list") return client.spaces.list();
      if (sub === "get") {
        if (!id) throw new Error("usage: spaces get <id>");
        return client.spaces.get(id);
      }
      throw new Error("usage: spaces <list | get <id>>");
    }
    case "data-views": {
      const [sub = "", id] = cmdArgs;
      if (sub === "list") return client.dataViews.list();
      if (sub === "get") {
        if (!id) throw new Error("usage: data-views get <id>");
        return client.dataViews.get(id);
      }
      throw new Error("usage: data-views <list | get <id>>");
    }
    case "search": {
      if (!args.index) {
        throw new Error(
          'usage: search --index <pattern> [--space <id>] [--phrase <text>] [--last 24h | --from <iso> --to <iso>] [--size 100]',
        );
      }
      const body = buildSearchBody(args);
      const raw = await client.search({ space: args.space, index: args.index, body });
      return args.raw ? raw : shapeSearchResult(raw, { space: args.space, index: args.index });
    }
    case "get": {
      const [path] = cmdArgs;
      if (!path) throw new Error("usage: get <path>");
      return client.get(path);
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
  // masked by a config/KIBANA_URL error on first run.
  const known = new Set(["envs", "status", "spaces", "data-views", "search", "get"]);
  if (!known.has(command)) {
    console.error(HELP);
    console.error(`error: unknown command: ${command}`);
    process.exit(2);
  }

  // "envs" lists names + redacted url + auth KIND — no live connection; keys,
  // usernames and passwords are never printed.
  if (command === "envs") {
    try {
      const listing = listEnvs(loadKibanaConfig({ configPath: args.configPath }));
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
  const legacyMode = Boolean(args.url) || (!hasConfig && Boolean(process.env.KIBANA_URL));
  if (!legacyMode && !hasConfig) {
    console.error(
      "error: no Kibana target configured. Create .myws/kibana.config.json (run \"mycastle kibana --help\"), " +
        "set KIBANA_URL (+ KIBANA_API_KEY or KIBANA_USERNAME/KIBANA_PASSWORD), or pass --url.",
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
  const cfg = loadKibanaConfig({ configPath: args.configPath });
  const results: Record<string, unknown> = {};
  for (const envName of resolveEnvs(cfg, args.env)) {
    const entry = cfg.envs[envName]!;
    // Non-secret CLI overrides on top of the file entry.
    if (args.basePath) entry.basePath = args.basePath;
    if (args.timeoutMs) entry.timeoutMs = args.timeoutMs;
    try {
      const client = new KibanaClient(toClientOptions(entry));
      results[envName] = await runCommand(command, cmdArgs, args, client);
    } catch (e) {
      results[envName] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  print(results, args.compact);
}
