// yapi.ts — thin CLI over src/lib/yapi-client.js (YApi). Read commands are
// free; the write commands (cat-add / iface-move / iface-add / iface-up) are
// dry-run unless --apply.
//
//   mycastle yapi <command> [args] [--env <name>] [--project <pid>] [options]
//
// Two auth modes (config-driven):
//   session — username/password login; one account covers all its projects.
//   token   — per-project openapi token (tokens[pid]).
//
// Commands:
//   envs                     list configured envs (url + auth mode, no secrets)
//   login / logout           session-mode: login (persist cookie) / logout
//   status                   connectivity / auth probe
//   projects                 session-mode: groups + accessible projects
//   project <pid>            project basic info
//   cats <pid> [--full]      categories + interface lists (summarized unless --full)
//   interfaces <pid>         flat interface list (all pages)
//   cat-ifaces <pid> --cat <catid>   one category's interfaces (all pages)
//   interface <id>           full detail of one interface
//   token <pid>              session-mode: fetch a project's openapi token
//   url <pid> [ifaceId] [--cat <catid>]   build YApi web URLs (project/category/interface)
//   search <pid> --q <kw> [--status <s>]   client-side filter over the interface list
//   export <pid>             snapshot project + categories + full details to local JSON
//   cat-add <pid> --name <n> [--desc <d>] [--apply]        create a category (dry-run by default)
//   iface-move <id> --cat <catid> [--message <m>] [--apply]  change an interface's category
//   iface-add <pid> --file <spec.json> [--apply]             create interfaces from a JSON spec
//   iface-up <id> --file <patch.json> [--apply]              patch one interface's fields
//
// Secrets are read ONLY from .myws/yapi.config.json (gitignored), never from flags.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import {
  loadYapiConfig,
  resolveAuth,
  resolveEnvs,
  type YapiConfig,
} from "./lib/yapi-config.js";
import {
  YapiClient,
  summarizeInterface,
  type YapiSnapshot,
} from "./lib/yapi-client.js";
import { configDir, ensureDir } from "./lib/platform.js";
import { redactUrlCredentials } from "./lib/redact.js";

interface CliArgs {
  rest: string[];
  env?: string;
  project?: string;
  configPath?: string;
  compact: boolean;
  help: boolean;
}

const HELP = `yapi — YApi CLI (JSON to stdout)

Usage:
  mycastle yapi <command> [args] [options]

Commands:
  envs                     list configured envs (url + auth mode, no secrets)
  login / logout           session-mode: login (persist cookie) / logout
  status                   connectivity / auth probe
  projects                 session-mode: groups + accessible projects
  project <pid>            project basic info
  cats <pid> [--full]      categories + interface lists (summarized unless --full)
  interfaces <pid>         flat interface list (all pages)
  cat-ifaces <pid> --cat <catid>   one category's interfaces (all pages)
  interface <id>           full detail of one interface (--project optional in session mode)
  token <pid>              session-mode: fetch a project's openapi token
  url <pid> [ifaceId] [--cat <catid>]    build YApi web URLs (project/category/interface)
  search <pid> --q <kw> [--status <s>]   filter interfaces by title/path keyword
  export <pid>             snapshot project + categories + full details to local JSON
  cat-add <pid> --name <n> [--desc <d>] [--apply]
                           create a category (prints the plan unless --apply)
  iface-move <id> --cat <catid> [--message <m>] [--apply]
                           change one interface's category (same project)
  iface-add <pid> --file <spec.json> [--apply]
                           create interfaces from a JSON spec (object or array)
  iface-up <id> --file <patch.json> [--apply]
                           patch one interface's fields (only keys in the file change)

Options:
  --env <name|all|a,b>     target env(s); default = config "default" or first env
  --project <pid>          target project (used by "interface <id>"; other commands
                           take <pid> as their positional argument)
  --config <path>          override .myws/yapi.config.json
  --compact                single-line JSON (default: pretty)
  --url                    (cats/interfaces/cat-ifaces/search) add webUrl to each item
  -h, --help               show this help

Auth modes (from .myws/yapi.config.json, gitignored; never from flags):
  session — username/password; one login covers every accessible project
  token   — per-project openapi token (project settings -> token page)
`;

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { rest: [], compact: false, help: false };
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
      case "--env":
        a.env = next();
        break;
      case "--project":
        a.project = next();
        break;
      case "--config":
        a.configPath = next();
        break;
      case "--compact":
        a.compact = true;
        break;
      default:
        a.rest.push(arg);
    }
  }
  return a;
}

function print(value: unknown, compact: boolean): void {
  console.log(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

/** Parse --key value tokens (no positionals). Throws on a missing value. */
function parseFlags(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      const v = tokens[++i];
      if (v === undefined) throw new Error(`${t} requires a value`);
      out[t.slice(2)] = v;
    }
  }
  return out;
}

/** Top-level property names of a JSON-schema string, plus its data/data.items branches. */
function schemaProps(raw: unknown): Record<string, string[]> {
  const empty: Record<string, string[]> = { root: [], data: [], "data.items": [] };
  if (typeof raw !== "string" || raw.length === 0) return empty;
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return empty;
  }
  const propsOf = (node: unknown): string[] => {
    if (node === null || typeof node !== "object") return [];
    const props = (node as Record<string, unknown>).properties;
    if (props === null || typeof props !== "object") return [];
    return Object.keys(props as Record<string, unknown>);
  };
  const data = (root as { properties?: Record<string, unknown> }).properties?.data;
  const items = (data as { items?: unknown } | undefined)?.items;
  return { root: propsOf(root), data: propsOf(data), "data.items": propsOf(items) };
}

/** added/removed property names between two schema strings (empty object = no diff). */
function diffSchema(beforeRaw: unknown, afterRaw: unknown): Record<string, { added: string[]; removed: string[] }> {
  const b = schemaProps(beforeRaw);
  const a = schemaProps(afterRaw);
  const out: Record<string, { added: string[]; removed: string[] }> = {};
  for (const key of Object.keys(a)) {
    const before = b[key] ?? [];
    const after = a[key] ?? [];
    const added = after.filter((n) => !before.includes(n));
    const removed = before.filter((n) => !after.includes(n));
    if (added.length > 0 || removed.length > 0) out[key] = { added, removed };
  }
  return out;
}

function parseId(v: string | undefined, what: string): number {
  const id = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(id)) throw new Error(`usage: ${what}`);
  return id;
}

/** Validate + fill defaults for one interface spec (see src/yapi.md §3 iface-add). */
function normalizeIfaceSpec(raw: unknown, pid: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("iface-add: each spec item must be an object");
  }
  const s = raw as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const title = text(s.title);
  const pathValue = text(s.path);
  const method = text(s.method).toUpperCase();
  const catid = Number(s.catid);
  if (title.length === 0) throw new Error("iface-add: spec.title is required");
  if (!pathValue.startsWith("/")) throw new Error(`iface-add: spec.path must start with "/" (${pathValue})`);
  if (method.length === 0) throw new Error("iface-add: spec.method is required");
  if (!Number.isFinite(catid)) throw new Error("iface-add: spec.catid is required");

  const out: Record<string, unknown> = {
    project_id: Number(pid),
    title,
    path: pathValue,
    method,
    catid,
  };
  const passThrough = [
    "desc",
    "status",
    "req_headers",
    "req_query",
    "req_params",
    "req_body_type",
    "req_body_form",
    "req_body_other",
    "res_body_type",
    "res_body",
    "markdown",
    "tag",
    "api_opened",
    "req_body_is_json_schema",
    "res_body_is_json_schema",
  ];
  for (const k of passThrough) if (s[k] !== undefined) out[k] = s[k];

  out.status = out.status ?? "done";
  out.req_headers = out.req_headers ?? [];
  out.req_query = out.req_query ?? [];
  out.req_params = out.req_params ?? [];
  out.req_body_form = out.req_body_form ?? [];
  out.res_body_type = out.res_body_type ?? "json";
  if (out.req_body_other !== undefined && out.req_body_type === undefined) out.req_body_type = "json";
  out.req_body_type = out.req_body_type ?? "json";
  if (out.res_body !== undefined && out.res_body_is_json_schema === undefined) out.res_body_is_json_schema = true;
  if (out.req_body_other !== undefined && out.req_body_is_json_schema === undefined) out.req_body_is_json_schema = true;
  return out;
}

/** Write a snapshot to <configDir>/yapi/snapshots/<env>/<pid>-<YYYYMMDDTHHMMSSZ>.json. */
function writeSnapshotFile(snap: YapiSnapshot): string {
  const ts = snap.takenAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261023T120000Z
  const dir = path.join(configDir, "yapi", "snapshots", snap.env);
  ensureDir(dir);
  const file = path.join(dir, `${snap.projectId}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2), "utf8");
  return file;
}

/** Commands whose first positional arg is the project id. */
const PID_COMMANDS = new Set([
  "project",
  "cats",
  "interfaces",
  "cat-ifaces",
  "search",
  "export",
  "cat-add",
  "iface-add",
]);

/** Run one command against one env. Returns JSON-serializable data (or throws). */
async function runEnv(
  command: string,
  cmdArgs: string[],
  envName: string,
  cfg: YapiConfig,
  args: CliArgs,
): Promise<unknown> {
  const envCfg = cfg.envs[envName]!;
  // pid source: positional <pid> for pid-commands, --project flag for the rest.
  const pidArg = PID_COMMANDS.has(command) ? cmdArgs[0] : args.project;
  const auth = resolveAuth(envCfg, pidArg);
  const client = new YapiClient({ env: envName, baseUrl: envCfg.url, auth });
  const base = envCfg.url.replace(/\/+$/, "");

  switch (command) {
    case "login":
      await client.login();
      return { env: envName, login: true, username: auth.mode === "session" ? auth.username : undefined };
    case "logout":
      await client.logout();
      return { env: envName, logout: true };
    case "status":
      return client.status();
    case "projects":
      return { projects: await client.projects() };
    case "project":
      return { projectId: client.projectId, project: await client.project() };
    case "cats": {
      const cats = await client.menu();
      const pid = client.projectId ?? "";
      const full = cmdArgs.includes("--full");
      const withUrl = cmdArgs.includes("--url");
      const itemUrl = (iid: number): string => `${base}/project/${pid}/interface/api/${iid}`;
      return {
        projectId: client.projectId,
        categories: cats.map((c) => ({
          ...c,
          ...(withUrl ? { webUrl: `${base}/project/${pid}/interface/api/cat_${c._id}` } : {}),
          list: (c.list ?? [])
            .map((it) => (full ? it : summarizeInterface(it)))
            .map((it) => (withUrl ? { ...it, webUrl: itemUrl(it._id) } : it)),
        })),
      };
    }
    case "interfaces": {
      const list = await client.interfaces();
      const pid = client.projectId ?? "";
      const withUrl = cmdArgs.includes("--url");
      return {
        projectId: client.projectId,
        interfaces: withUrl
          ? list.map((it) => ({ ...it, webUrl: `${base}/project/${pid}/interface/api/${it._id}` }))
          : list,
      };
    }
    case "cat-ifaces": {
      const rest = cmdArgs.slice(1);
      const withUrl = rest.includes("--url");
      const flags = parseFlags(rest.filter((t) => t !== "--url"));
      if (flags.cat === undefined) throw new Error("cat-ifaces requires --cat <catid>");
      const catid = parseId(flags.cat, "cat-ifaces <pid> --cat <catid>");
      const list = await client.categoryInterfaces(catid);
      const pid = client.projectId ?? "";
      return {
        projectId: client.projectId,
        catid,
        interfaces: withUrl
          ? list.map((it) => ({ ...it, webUrl: `${base}/project/${pid}/interface/api/${it._id}` }))
          : list,
      };
    }
    case "interface": {
      const id = parseId(cmdArgs[0], "interface <id> [--project <pid>]");
      const detail = await client.getInterface(id);
      const pid = client.projectId;
      return {
        ...(pid ? { webUrl: `${base}/project/${pid}/interface/api/${id}` } : {}),
        ...detail,
      };
    }
    case "url": {
      const pid = cmdArgs[0];
      if (pid === undefined || pid.startsWith("--")) {
        throw new Error("usage: url <pid> [interfaceId] [--cat <catid>]");
      }
      const rest = cmdArgs.slice(1);
      const flags = parseFlags(rest.filter((t) => t !== "--url"));
      const apiBase = `${base}/project/${pid}/interface/api`;
      const out: Record<string, string> = { projectId: pid, project: apiBase };
      if (rest[0] !== undefined && !rest[0].startsWith("--")) out.interface = `${apiBase}/${rest[0]}`;
      if (flags.cat !== undefined) out.category = `${apiBase}/cat_${flags.cat}`;
      return out;
    }
    case "token": {
      const pid = cmdArgs[0] ?? args.project;
      if (pid === undefined) throw new Error("usage: token <pid>");
      return { projectId: pid, token: await client.projectToken(pid) };
    }
    case "search": {
      const rest = cmdArgs.slice(1);
      const withUrl = rest.includes("--url");
      const flags = parseFlags(rest.filter((t) => t !== "--url"));
      if (flags.q === undefined) throw new Error("search requires --q <keyword>");
      const found = await client.search(flags.q, { status: flags.status });
      const pid = client.projectId ?? "";
      return {
        projectId: client.projectId,
        q: flags.q,
        interfaces: withUrl
          ? found.map((it) => ({ ...it, webUrl: `${base}/project/${pid}/interface/api/${it._id}` }))
          : found,
      };
    }
    case "export": {
      const snap = await client.snapshot();
      const file = writeSnapshotFile(snap);
      console.error(`export[${envName}/${snap.projectId}] -> ${file}`);
      return snap;
    }
    case "cat-add": {
      const pid = cmdArgs[0];
      if (pid === undefined || pid.startsWith("--")) {
        throw new Error("usage: cat-add <pid> --name <name> [--desc <text>] [--apply]");
      }
      const rest = cmdArgs.slice(1);
      const apply = rest.includes("--apply");
      const flags = parseFlags(rest.filter((t) => t !== "--apply"));
      if (flags.name === undefined || flags.name.length === 0) {
        throw new Error("cat-add requires --name <name>");
      }
      if (!apply) {
        return { dryRun: true, action: "cat-add", projectId: pid, name: flags.name, desc: flags.desc };
      }
      const cat = await client.addCategory(flags.name, flags.desc, pid);
      const catid = Number((cat as { _id?: unknown })._id);
      const hasId = Number.isFinite(catid);
      return {
        applied: true,
        action: "cat-add",
        ...cat,
        ...(hasId
          ? { catid, webUrl: `${base}/project/${pid}/interface/api/cat_${catid}` }
          : {}),
      };
    }
    case "iface-move": {
      const id = parseId(cmdArgs[0], "iface-move <id> --cat <catid> [--message <text>] [--apply]");
      const rest = cmdArgs.slice(1);
      const apply = rest.includes("--apply");
      const flags = parseFlags(rest.filter((t) => t !== "--apply"));
      if (flags.cat === undefined) throw new Error("iface-move requires --cat <catid>");
      const catid = parseId(flags.cat, "iface-move <id> --cat <catid>");
      const before = await client.getInterface(id);
      const plan = {
        id,
        title: before.title,
        path: before.path,
        method: before.method,
        fromCatid: before.catid,
        toCatid: catid,
      };
      if (!apply) return { dryRun: true, action: "iface-move", ...plan };
      const message =
        flags.message ?? `分类调整:cat_${before.catid} -> cat_${catid}`;
      await client.moveInterface(id, catid, message);
      const after = await client.getInterface(id);
      const pid = after.project_id ?? before.project_id;
      return {
        applied: true,
        action: "iface-move",
        ...plan,
        catid: after.catid,
        title: after.title,
        path: after.path,
        method: after.method,
        otherFieldsIntact:
          after.title === before.title &&
          after.path === before.path &&
          after.method === before.method,
        ...(pid !== undefined
          ? { webUrl: `${base}/project/${pid}/interface/api/${id}` }
          : {}),
      };
    }
    case "iface-add": {
      const pid = cmdArgs[0];
      if (pid === undefined || pid.startsWith("--")) {
        throw new Error("usage: iface-add <pid> --file <spec.json> [--apply]");
      }
      const rest = cmdArgs.slice(1);
      const apply = rest.includes("--apply");
      const flags = parseFlags(rest.filter((t) => t !== "--apply"));
      if (flags.file === undefined) throw new Error("iface-add requires --file <spec.json>");
      const parsed: unknown = JSON.parse(fs.readFileSync(flags.file, "utf8").replace(/^\uFEFF/, ""));
      const specs = (Array.isArray(parsed) ? parsed : [parsed]).map((it) => normalizeIfaceSpec(it, pid));

      // Safety: every target category must exist inside this project.
      const menu = await client.menu();
      const catids = new Set(menu.map((c) => c._id));
      for (const spec of specs) {
        const catid = Number(spec.catid);
        if (!catids.has(catid)) {
          throw new Error(`catid ${catid} is not in project ${pid} (categories: ${[...catids].join(",")})`);
        }
      }

      const summary = specs.map((s) => ({
        title: s.title,
        method: s.method,
        path: s.path,
        catid: s.catid,
      }));
      if (!apply) return { dryRun: true, action: "iface-add", projectId: pid, count: specs.length, interfaces: summary };

      const created: Array<Record<string, unknown>> = [];
      const failed: Array<{ title: unknown; error: string }> = [];
      for (const spec of specs) {
        try {
          const doc = await client.addInterface(spec);
          created.push({
            id: doc._id,
            title: doc.title,
            method: doc.method,
            path: doc.path,
            catid: doc.catid,
            webUrl: `${base}/project/${pid}/interface/api/${doc._id}`,
          });
        } catch (e) {
          failed.push({ title: spec.title, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { applied: true, action: "iface-add", projectId: pid, created, failed };
    }
    case "iface-up": {
      const id = parseId(cmdArgs[0], "iface-up <id> --file <patch.json> [--apply]");
      const rest = cmdArgs.slice(1);
      const apply = rest.includes("--apply");
      const flags = parseFlags(rest.filter((t) => t !== "--apply"));
      if (flags.file === undefined) throw new Error("iface-up requires --file <patch.json>");
      const parsed: unknown = JSON.parse(fs.readFileSync(flags.file, "utf8").replace(/^\uFEFF/, ""));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("iface-up: patch file must be a single JSON object");
      }
      const patch: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
      const allowed = new Set([
        "title",
        "path",
        "method",
        "catid",
        "status",
        "desc",
        "markdown",
        "tag",
        "api_opened",
        "req_headers",
        "req_query",
        "req_params",
        "req_body_type",
        "req_body_form",
        "req_body_other",
        "req_body_is_json_schema",
        "res_body_type",
        "res_body",
        "res_body_is_json_schema",
      ]);
      if ("id" in patch) throw new Error('iface-up: do not put "id" in the patch file');
      for (const key of Object.keys(patch)) {
        if (!allowed.has(key)) throw new Error(`iface-up: unsupported field "${key}"`);
      }
      if (patch.req_body_other !== undefined) {
        patch.req_body_is_json_schema = patch.req_body_is_json_schema ?? true;
        patch.req_body_type = patch.req_body_type ?? "json";
      }
      if (patch.res_body !== undefined) {
        patch.res_body_is_json_schema = patch.res_body_is_json_schema ?? true;
        patch.res_body_type = patch.res_body_type ?? "json";
      }
      const before = await client.getInterface(id);
      if (patch.catid !== undefined) {
        const catid = Number(patch.catid);
        if (!Number.isFinite(catid)) throw new Error("iface-up: catid must be a number");
        const menu = await client.menu();
        if (!menu.some((c) => c._id === catid)) {
          throw new Error(`iface-up: catid ${catid} is not a category of this project`);
        }
        patch.catid = catid;
      }

      const beforeRec = before as unknown as Record<string, unknown>;
      const changed = Object.keys(patch).filter(
        (k) => JSON.stringify(beforeRec[k] ?? null) !== JSON.stringify(patch[k] ?? null),
      );
      const plan = {
        id,
        title: (patch.title ?? before.title) as string,
        method: (patch.method ?? before.method) as string,
        path: (patch.path ?? before.path) as string,
        catid: patch.catid ?? before.catid,
        fields: Object.keys(patch),
        changed,
        reqSchemaDiff: patch.req_body_other !== undefined ? diffSchema(beforeRec.req_body_other, patch.req_body_other) : undefined,
        resSchemaDiff: patch.res_body !== undefined ? diffSchema(beforeRec.res_body, patch.res_body) : undefined,
      };
      if (!apply) return { dryRun: true, action: "iface-up", ...plan };

      await client.updateInterface(id, patch);
      const after = await client.getInterface(id);
      const afterRec = after as unknown as Record<string, unknown>;
      const pid = after.project_id ?? before.project_id;
      return {
        applied: true,
        action: "iface-up",
        ...plan,
        title: after.title,
        method: after.method,
        path: after.path,
        catid: after.catid,
        appliedMatches: changed.every(
          (k) => JSON.stringify(afterRec[k] ?? null) === JSON.stringify(patch[k] ?? null),
        ),
        ...(pid !== undefined
          ? { webUrl: `${base}/project/${pid}/interface/api/${id}` }
          : {}),
      };
    }
    default:
      throw new Error(`command "${command}" not implemented yet`);
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
  const known = new Set([
    "envs",
    "login",
    "logout",
    "status",
    "projects",
    "project",
    "cats",
    "interfaces",
    "cat-ifaces",
    "interface",
    "url",
    "token",
    "search",
    "export",
    "cat-add",
    "iface-move",
    "iface-add",
    "iface-up",
  ]);
  if (!known.has(command)) {
    console.error(HELP);
    console.error(`error: unknown command: ${command}`);
    process.exit(2);
  }

  // "envs" lists configured envs without secrets — redacted url + auth mode
  // (+username, which identifies the account); password/token never printed.
  if (command === "envs") {
    const cfg = loadYapiConfig({ configPath: args.configPath });
    const envs = Object.entries(cfg.envs).map(([name, e]) => {
      const hasSession =
        typeof e.username === "string" && e.username.length > 0 &&
        typeof e.password === "string" && e.password.length > 0;
      const tokenIds = Object.keys(e.tokens ?? {});
      const auth = hasSession && tokenIds.length > 0 ? "session+token" : hasSession ? "session" : "token";
      return {
        name,
        url: redactUrlCredentials(e.url),
        auth,
        username: hasSession ? e.username : undefined,
        projects: tokenIds.length > 0 ? tokenIds : undefined,
      };
    });
    print({ default: cfg.default ?? envs[0]?.name ?? null, envs }, args.compact);
    return;
  }

  const cfg = loadYapiConfig({ configPath: args.configPath });
  const envNames = resolveEnvs(cfg, args.env);

  const results: Record<string, unknown> = {};
  for (const envName of envNames) {
    try {
      results[envName] = await runEnv(command, cmdArgs, envName, cfg, args);
    } catch (e) {
      results[envName] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  print(results, args.compact);
}
