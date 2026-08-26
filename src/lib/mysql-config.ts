// mysql-config.ts — resolve a DB connection.
//   1. DB_CONN_URL env var (highest priority) — single connection; --conn ignored.
//   2. .myws/db.config.json (gitignored):
//        flat  : { "url": "mysql://..." }
//        multi : { "default": "x", "connections": { "x": { "url": "mysql://..." } } }
// Real URLs/passwords live ONLY in the env var or this file; never in code or flags.
// Never return these values to stdout; enumerate via the redacted `conns` command.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export interface DBConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  charset: string;
}

interface ConnEntry {
  url: string;
}

interface RawConfig {
  default?: string;
  url?: string; // flat single-connection form
  connections?: Record<string, ConnEntry>;
}

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), ".myws", "db.config.json");

/** Default config path: <cwd>/.myws/db.config.json (cwd = workspace root). */
export function defaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

/** Recognized mysql URL schemes; everything normalizes to mysql:// for URL parsing. */
const URL_SCHEMES = ["mysql+aiomysql://", "mysql+pymysql://", "mysql://"];

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse a mysql://... URL into a DBConfig. Throws on malformed input. */
export function parseMysqlUrl(raw: string): DBConfig {
  const original = raw;
  let s = raw.trim();
  let matched = false;
  for (const scheme of URL_SCHEMES) {
    if (s.startsWith(scheme)) {
      s = `mysql://${s.slice(scheme.length)}`;
      matched = true;
      break;
    }
  }
  if (!matched && !s.startsWith("mysql://")) {
    s = `mysql://${s}`;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Invalid DB_CONN_URL: ${original}`);
  }
  if (!u.hostname) throw new Error(`Invalid DB_CONN_URL (no host): ${original}`);
  const port = u.port ? Number.parseInt(u.port, 10) : 3306;
  const database = safeDecode(u.pathname.replace(/^\/+/, ""));
  const charset = u.searchParams.get("charset") ?? "utf8mb4";
  return {
    host: u.hostname,
    port,
    user: safeDecode(u.username),
    password: safeDecode(u.password),
    database,
    charset,
  };
}

export interface ResolvedConnection {
  /** Connection name (from config file) or "DB_CONN_URL" when sourced from the env var. */
  name: string;
  /** True when the connection came from the DB_CONN_URL env var. */
  fromEnv: boolean;
  config: DBConfig;
}

export interface ResolveOpts {
  /** Named connection to pick from a multi-connection config file. */
  connName?: string;
  /** Override the default .myws/db.config.json path. */
  configPath?: string;
}

/** Read + JSON.parse the config file. Throws actionable errors pointing at the docs. */
function readRawConfig(configPath: string): RawConfig {
  let raw: RawConfig;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as RawConfig;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot read mysql config at ${configPath}: ${msg}. ` +
        `Set DB_CONN_URL env var or create .myws/db.config.json (run "mycastle mysql --help").`,
    );
  }
  return raw;
}

/**
 * Resolve a DB connection.
 *   1. DB_CONN_URL env var (highest priority) — single connection; --conn ignored.
 *   2. .myws/db.config.json — flat `{url}` or multi `{default,connections}` form.
 *      --conn picks a named connection; else cfg.default; else the first one.
 */
export function resolveConnection(opts: ResolveOpts = {}): ResolvedConnection {
  const envUrl = process.env.DB_CONN_URL;
  if (envUrl) {
    return { name: "DB_CONN_URL", fromEnv: true, config: parseMysqlUrl(envUrl) };
  }

  const configPath = opts.configPath
    ? path.resolve(process.cwd(), opts.configPath)
    : DEFAULT_CONFIG_PATH;

  const raw = readRawConfig(configPath);

  // Flat single-connection form.
  if (typeof raw.url === "string" && raw.url.length > 0) {
    return { name: "default", fromEnv: false, config: parseMysqlUrl(raw.url) };
  }

  // Multi-connection form.
  const conns = raw.connections;
  if (!conns || typeof conns !== "object" || Object.keys(conns).length === 0) {
    throw new Error(
      `Config ${configPath} has neither a top-level "url" nor a "connections" object. ` +
        `Run "mycastle mysql --help".`,
    );
  }
  const valid = Object.keys(conns);
  const name =
    opts.connName && valid.includes(opts.connName)
      ? opts.connName
      : raw.default && valid.includes(raw.default)
        ? raw.default
        : (valid[0] as string);
  const entry = conns[name];
  if (!entry || typeof entry.url !== "string" || entry.url.length === 0) {
    throw new Error(`Connection "${name}" in ${configPath} has no "url".`);
  }
  return { name, fromEnv: false, config: parseMysqlUrl(entry.url) };
}

// ---------------------------------------------------------------------------
// Redacted enumeration (`mycastle mysql conns`) — lets agents list connections
// without ever reading .myws/db.config.json or DB_CONN_URL raw.
// ---------------------------------------------------------------------------

/** Masked connection summary for the "conns" command — never carries a real password. */
export interface ConnectionSummary {
  name: string;
  fromEnv: boolean;
  /** True when resolveConnection() would pick this one by default. */
  isDefault: boolean;
  host: string;
  port: number;
  user: string;
  database: string;
  password: "***"; // literal type: assigning a real password is a compile error
}

/** A connection whose URL failed to parse — the payload is the error, not the secret. */
export interface ConnectionError {
  name: string;
  fromEnv: boolean;
  isDefault: boolean;
  error: string;
}

export interface ConnectionList {
  /** "env" = DB_CONN_URL won (config file ignored); "config" = read from file. */
  source: "env" | "config";
  configPath?: string;
  default: string | null;
  connections: Array<ConnectionSummary | ConnectionError>;
}

/** Parse a URL into a masked summary; a bad URL degrades to an error entry. */
function summarize(
  name: string,
  url: string,
  fromEnv: boolean,
  isDefault: boolean,
): ConnectionSummary | ConnectionError {
  try {
    const c = parseMysqlUrl(url);
    return {
      name,
      fromEnv,
      isDefault,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      password: "***",
    };
  } catch (e) {
    return { name, fromEnv, isDefault, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * List configured connections with passwords masked — mirrors resolveConnection's
 * source precedence (DB_CONN_URL first, config file ignored when set). Individual
 * malformed URLs degrade to error entries instead of failing the whole listing.
 */
export function listConnections(opts: { configPath?: string } = {}): ConnectionList {
  const envUrl = process.env.DB_CONN_URL;
  if (envUrl) {
    // Single source; if it's broken there is nothing else to list — throw like
    // resolveConnection does.
    const config = parseMysqlUrl(envUrl);
    return {
      source: "env",
      default: "DB_CONN_URL",
      connections: [
        {
          name: "DB_CONN_URL",
          fromEnv: true,
          isDefault: true,
          host: config.host,
          port: config.port,
          user: config.user,
          database: config.database,
          password: "***",
        },
      ],
    };
  }

  const configPath = opts.configPath
    ? path.resolve(process.cwd(), opts.configPath)
    : DEFAULT_CONFIG_PATH;
  const raw = readRawConfig(configPath);

  // Flat single-connection form.
  if (typeof raw.url === "string" && raw.url.length > 0) {
    return {
      source: "config",
      configPath,
      default: "default",
      connections: [summarize("default", raw.url, false, true)],
    };
  }

  // Multi-connection form.
  const conns = raw.connections;
  if (!conns || typeof conns !== "object" || Object.keys(conns).length === 0) {
    throw new Error(
      `Config ${configPath} has neither a top-level "url" nor a "connections" object. ` +
        `Run "mycastle mysql --help".`,
    );
  }
  const names = Object.keys(conns);
  const def = raw.default && names.includes(raw.default) ? raw.default : (names[0] as string);
  return {
    source: "config",
    configPath,
    default: def,
    connections: names.map((name) => {
      const entry = conns[name];
      if (!entry || typeof entry.url !== "string" || entry.url.length === 0) {
        return {
          name,
          fromEnv: false,
          isDefault: name === def,
          error: `Connection "${name}" in ${configPath} has no "url".`,
        } satisfies ConnectionError;
      }
      return summarize(name, entry.url, false, name === def);
    }),
  };
}
