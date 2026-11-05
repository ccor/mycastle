// index.ts — public programmatic surface of mycastle.
// Stable API for third-party extensions: `import { ... } from "mycastle"`.
// The CLI entry is separate (bin -> dist/cli.js); nothing here imports ./cli.js
// and importing this module has no side effects.
// Deep imports (mycastle/dist/lib/<name>.js) stay available; changing their
// signatures is treated as a minor-version breaking change (see AGENTS.md).
//
// Curated, not exhaustive: each lib module re-exports only its stable face.
// Cross-module name collisions are renamed with `as`
// (resolveEnvs -> resolveKibanaEnvs / resolveArcheryEnvs / resolveXxljobEnvs).

// --- tool contract -----------------------------------------------------------

/** Contract every bundled CLI tool module implements (routed by src/cli.ts):
 *  `export async function run(argv: string[]): Promise<void>`. */
export type ToolRun = (argv: string[]) => Promise<void> | void;

// --- platform ------------------------------------------------------------------

export {
  platform,
  arch,
  isWindows,
  isMac,
  isLinux,
  platformLabel,
  configDir,
  ensureDir,
} from "./lib/platform.js";

// --- redaction -----------------------------------------------------------------

export { redactUrlCredentials } from "./lib/redact.js";

// --- kibana ----------------------------------------------------------------------

export {
  KibanaClient,
  KibanaApiError,
  toApiKeyToken,
  resolveAuth,
} from "./lib/kibana-client.js";
export type {
  KibanaAuth,
  KibanaAuthSource,
  KibanaClientOptions,
  KibanaStatus,
  Space,
  DataViewListItem,
  DataView,
  EsSearchResponse,
  SpaceSearchParams,
} from "./lib/kibana-client.js";
export {
  loadKibanaConfig,
  configExists,
  resolveAuthMode,
  resolveEnvs as resolveKibanaEnvs,
  listEnvs as listKibanaEnvs,
  toClientOptions,
} from "./lib/kibana-config.js";
export type {
  KibanaConfig,
  KibanaEnvConfig,
  KibanaAuthMode,
  KibanaEnvListing,
} from "./lib/kibana-config.js";

// --- archery ---------------------------------------------------------------------

export {
  ArcheryClient,
  ArcheryApiError,
  INSTANCE_TAGS,
  isTerminalWorkflowStatus,
  splitSqlStatements,
  stripNonTicketStatements,
  parseGroupOptions,
  cookieFromSetCookies,
} from "./lib/archery-client.js";
export type {
  InstanceTag,
  WorkflowListOpts,
  QuerylogListOpts,
  QueryRunOpts,
  ArcheryEnvelope,
  ArcheryQueryStep,
  ArcheryPage,
  WorkflowRow,
  QuerylogRow,
  InstanceRow,
  WorkflowGroup,
  SqlCheckRow,
  SqlCheckResult,
  WorkflowSubmitResult,
  WorkflowDetailContent,
  WorkflowActionProbe,
  WorkflowWaitOpts,
  WorkflowWaitResult,
} from "./lib/archery-client.js";
export {
  loadArcheryConfig,
  resolveEnvs as resolveArcheryEnvs,
} from "./lib/archery-config.js";
export type { ArcheryConfig, ArcheryEnvConfig } from "./lib/archery-config.js";

// --- prometheus -------------------------------------------------------------------

export {
  PrometheusClient,
  PrometheusApiError,
} from "./lib/prometheus-client.js";
export type {
  PrometheusAuth,
  PrometheusClientOptions,
  PromResponse,
  PromSeries,
  PromQueryData,
  PromRangeParams,
  PromTimeWindow,
  PromBuildInfo,
  PromTarget,
  PromTargetsData,
} from "./lib/prometheus-client.js";
export {
  loadPrometheusConfig,
  configExists as prometheusConfigExists,
  resolveAuthMode as resolvePrometheusAuthMode,
  resolveEnvs as resolvePrometheusEnvs,
  toClientOptions as toPrometheusClientOptions,
  listEnvs as listPrometheusEnvs,
} from "./lib/prometheus-config.js";
export type {
  PrometheusConfig,
  PrometheusEnvConfig,
  PrometheusAuthMode,
  PrometheusEnvListing,
} from "./lib/prometheus-config.js";

// --- jenkins -----------------------------------------------------------------------

export {
  JenkinsClient,
  JenkinsApiError,
  jobUrlPath,
  jobsTree,
  BUILD_ALIASES,
} from "./lib/jenkins-client.js";
export type {
  JenkinsClientOptions,
  JenkinsJobNode,
  JenkinsBuildRef,
  JenkinsParameterDefinition,
} from "./lib/jenkins-client.js";
export {
  loadJenkinsConfig,
  configExists as jenkinsConfigExists,
  resolveAuthMode as resolveJenkinsAuthMode,
  resolveEnvs as resolveJenkinsEnvs,
  toClientOptions as toJenkinsClientOptions,
  listEnvs as listJenkinsEnvs,
} from "./lib/jenkins-config.js";
export type {
  JenkinsConfig,
  JenkinsEnvConfig,
  JenkinsAuthMode,
  JenkinsEnvListing,
} from "./lib/jenkins-config.js";

// --- xxljob ------------------------------------------------------------------------

export { XxljobClient, XxljobApiError } from "./lib/xxljob-client.js";
export type { Executor, Job, JobLog, Snapshot } from "./lib/xxljob-client.js";
export {
  loadXxljobConfig,
  resolveEnvs as resolveXxljobEnvs,
} from "./lib/xxljob-config.js";
export type { XxljobConfig, XxljobEnvConfig } from "./lib/xxljob-config.js";

// --- yapi ---------------------------------------------------------------------------

export {
  YapiClient,
  YapiApiError,
  summarizeInterface,
  summarizeCategories,
} from "./lib/yapi-client.js";
export type {
  YapiClientAuth,
  YapiProject,
  YapiGroup,
  YapiInterfaceSummary,
  YapiInterface,
  YapiCategory,
  YapiSnapshot,
  YapiStatus,
} from "./lib/yapi-client.js";
export {
  loadYapiConfig,
  resolveEnvs as resolveYapiEnvs,
  resolveAuth as resolveYapiAuth,
} from "./lib/yapi-config.js";
export type { YapiConfig, YapiEnvConfig, YapiAuth as YapiAuthPlan } from "./lib/yapi-config.js";
export {
  readSession as readYapiSession,
  writeSession as writeYapiSession,
  clearSession as clearYapiSession,
} from "./lib/yapi-session.js";
export type { YapiSessionRecord } from "./lib/yapi-session.js";

// --- mysql -------------------------------------------------------------------------

export { MysqlHelper } from "./lib/mysql-client.js";
export {
  previewStatement,
  splitSqlStatements as splitMysqlStatements,
} from "./lib/mysql-client.js";
export type { ExecResult, Row as MysqlRow } from "./lib/mysql-client.js";
export {
  resolveConnection,
  listConnections,
  parseMysqlUrl,
} from "./lib/mysql-config.js";
export type {
  DBConfig,
  ResolvedConnection,
  ConnectionSummary,
  ConnectionList,
} from "./lib/mysql-config.js";

// --- data-sync -----------------------------------------------------------------------

export {
  quoteIdent,
  sqlLiteral,
  parseTableList,
  openSource,
  openDest,
  syncTables,
} from "./lib/data-sync.js";
export type { SyncMode } from "./lib/data-sync.js";

// --- repo changes (collector) ----------------------------------------------------------

export { collectRepoChanges } from "./lib/git-collect.js";
export type { RepoChanges } from "./lib/git-collect.js";
export { loadReposConfig } from "./lib/repos-config.js";
export type { RepoEntry } from "./lib/repos-config.js";

// --- state ------------------------------------------------------------------------------

export { readState, writeState, stateKey } from "./lib/state.js";
export type { State, RepoState } from "./lib/state.js";
