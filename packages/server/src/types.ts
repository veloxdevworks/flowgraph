import { MEMORY_SWEEP_MAX_INTERVAL_MS, type FlowgraphEvent, type RunResult, type StateSnapshot } from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";
import {
  ASYMMETRIC_ALGORITHMS,
  DEFAULT_CLOCK_TOLERANCE_SEC,
  DEFAULT_OIDC_ALGORITHMS,
  MAX_CLOCK_TOLERANCE_SEC,
  SHARED_SECRET_ALGORITHMS,
  type AuthMode,
  type OidcAuthConfig,
  type ServerAuthConfig,
} from "./identity.js";

/** Client-facing event shape (mirrors desktop EngineEvent / FlowgraphEvent). */
export type ServerEvent = FlowgraphEvent;

export type RunStatus =
  | "started"
  | "running"
  | "completed"
  | "interrupted"
  | "paused"
  | "error"
  | "cancelled";

export interface StartRunRequest {
  /** Stable checkpoint key. Required. */
  threadId: string;
  /** Graph YAML document (v1 graph-source). */
  yaml: string;
  /** Optional graph input. */
  input?: Record<string, unknown>;
  /** Optional human-readable label. */
  label?: string;
  /**
   * When true, compile with the built-in mock provider only (no LLM keys).
   * Mirrors the desktop sidecar `dryRun` flag.
   */
  dryRun?: boolean;
  /**
   * Rejected when present: remote runs resolve credentials server-side.
   * Kept in the type so we can return a clear 400.
   */
  env?: Record<string, string>;
}

export interface RunListItem {
  threadId: string;
  graphName: string;
  label?: string;
  status: RunStatus;
  updatedAt: string;
  startedAt?: string;
  active: boolean;
}

export interface RunDetail extends RunListItem {
  yaml: string;
  issues?: import("@flowgraph/core").RunIssue[];
}

export interface ResumeRunRequest {
  threadId: string;
  resume: unknown;
  /** Optional YAML when the session is cold (process restarted). */
  yaml?: string;
}

export interface StartRunResult {
  threadId: string;
  runId: string;
  status: "started";
  /** True when the uploaded YAML had an `imports` block that the server stripped. */
  importsStripped?: boolean;
}

export interface ControlResult {
  threadId: string;
  runId?: string;
  status: RunResult["status"] | "cancelled" | "started";
}

export interface GetStateResult {
  state: StateSnapshot | null;
}

export interface SessionInfo {
  threadId: string;
  runId: string;
  status: RunStatus;
  graphName: string;
  label?: string;
  startedAt: string;
  active: boolean;
}

export interface PersistedGraph {
  threadId: string;
  yaml: string;
  spec: GraphSpec;
  storedAt: string;
  updatedAt: string;
  label?: string;
  graphName?: string;
  status?: RunStatus;
}

/** The principal that created a thread; only it may run, read or control the thread on a multi-user server. */
export interface ThreadOwner {
  id: string;
  org: string;
}

export interface GraphMeta {
  threadId: string;
  storedAt: string;
  updatedAt: string;
  label?: string;
  graphName?: string;
  status?: RunStatus;
  owner?: ThreadOwner;
  /**
   * `raw`: the stored file is the YAML as uploaded, with any `${VAR}`
   * placeholders left in; they are filled only when a trusted author runs it.
   * Absent on files stored by older servers, which held expanded YAML and are
   * never expanded again.
   */
  yamlFormat?: "raw";
}

export interface ServerConfig {
  host: string;
  port: number;
  /**
   * Bearer token for REST. Required unless `authDisabled` is set
   * (`FLOWGRAPH_AUTH_DISABLED=1`).
   */
  authToken?: string;
  /**
   * Opt out of bearer auth (local/dev only). REST is refused without a token
   * when this is false/unset and `authToken` is also unset.
   */
  authDisabled?: boolean;
  /**
   * How callers are identified (OIDC, one legacy token, or none). Built from
   * FLOWGRAPH_AUTH_MODE / FLOWGRAPH_OIDC_* by `defaultServerConfig`. Unset:
   * `authToken` / `authDisabled` decide, and the single principal is trusted.
   */
  auth?: ServerAuthConfig;
  /** Postgres URL. When unset, use in-memory checkpointer (local smoke only). */
  databaseUrl?: string;
  /**
   * Where `runtime.memory` (and the durable `ctx.store` alias) lives. Default
   * `memory`: process-local, and graphs that declare durable memory fail to
   * compile. `postgres` shares the checkpointer's pool (needs `databaseUrl`);
   * `sqlite` keeps memory in a local file (needs @flowgraph/checkpoint-sqlite).
   */
  memory?: ServerMemoryConfig;
  /**
   * How long Postgres schema setup waits for another replica's setup lock, in ms.
   * Env: `FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS`. Default: the checkpoint-postgres default.
   */
  setupLockTimeoutMs?: number;
  /**
   * Hosts that http and webhook nodes in graphs from untrusted authors may reach
   * even though they resolve to non-public addresses (`host`, `host:port`,
   * `*.domain`). Cloud metadata and link-local addresses stay blocked.
   * Env: `FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS` (comma-separated). Default: none.
   */
  untrustedHttpAllowHosts?: string[];
  /** Directory for persisted uploaded graphs. */
  graphStoreDir: string;
  /** Max events retained per thread for SSE replay. */
  eventBufferSize: number;
  /** AWS region hint for Bedrock (also set on process.env). */
  awsRegion?: string;
  /**
   * Max JSON body size in bytes for POST /runs and control endpoints.
   * `0` = unlimited.
   */
  maxBodyBytes?: number;
  /**
   * Max concurrently running/started threads. `0` = unlimited. Default 16.
   */
  maxConcurrentRuns?: number;
  /**
   * Optional outbound control-plane WebSocket URL (ADR-0014).
   * Unset = connect client stays off.
   */
  connectUrl?: string;
  /** Token sent in the connect `hello` handshake. */
  connectToken?: string;
  /** `POST /voice/client-secrets` policy. */
  voice?: VoiceConfig;
}

export type ServerMemoryBackend = "memory" | "postgres" | "sqlite";

export interface ServerMemoryConfig {
  /** Env: `FLOWGRAPH_MEMORY_BACKEND`. Default `memory`. */
  backend: ServerMemoryBackend;
  /** sqlite file. Env: `FLOWGRAPH_MEMORY_SQLITE_PATH`. Default `<graphStoreDir>/memory.db`. */
  sqlitePath?: string;
  /**
   * Who owns memory written by this server: every run shares one identity.
   * Env: `FLOWGRAPH_ORG` (required for the postgres and sqlite backends),
   * `FLOWGRAPH_PROJECT` (default `local`), `FLOWGRAPH_USER`.
   */
  identity?: { org: string; project: string; user?: string };
  /** How often to delete expired memory and old op records, 1000 to 2^31-1 ms. Env: `FLOWGRAPH_MEMORY_SWEEP_MS`. Default 1h. */
  sweepIntervalMs?: number;
}

const MEMORY_BACKENDS: readonly ServerMemoryBackend[] = ["memory", "postgres", "sqlite"];

export interface VoiceConfig {
  /**
   * Mint voice tokens even when REST auth is off (`authDisabled` or no token).
   * Anyone who can reach the port can then spend the server's vendor key.
   * Default false. Env: `FLOWGRAPH_VOICE_ALLOW_UNAUTHENTICATED=1`.
   */
  allowUnauthenticated?: boolean;
  /**
   * Realtime models callers may request. Default: each provider's default
   * model only (see `DEFAULT_VOICE_MODELS`). Env: comma-separated
   * `FLOWGRAPH_VOICE_ALLOWED_MODELS`.
   */
  allowedModels?: string[];
}

function envList(env: NodeJS.ProcessEnv, key: string): string[] {
  return (env[key] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const AUTH_MODES: readonly AuthMode[] = ["oidc", "token", "none"];

function isLoopbackUrl(u: URL): boolean {
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
}

function checkHttpsUrl(key: string, raw: string, insecureDev: boolean): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${key} must be a URL (got "${raw}")`);
  }
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && (isLoopbackUrl(u) || insecureDev)) return;
  throw new Error(`${key} must use https (plain http is allowed for localhost, or with FLOWGRAPH_INSECURE_DEV=1)`);
}

/** Parse FLOWGRAPH_AUTH_MODE / FLOWGRAPH_OIDC_* into the auth config. Throws on contradictions. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerAuthConfig {
  const insecureDev = envFlag(env, "FLOWGRAPH_INSECURE_DEV");
  const rawMode = env.FLOWGRAPH_AUTH_MODE?.trim().toLowerCase();
  if (rawMode && !AUTH_MODES.includes(rawMode as AuthMode)) {
    throw new Error(`FLOWGRAPH_AUTH_MODE must be one of ${AUTH_MODES.join(" | ")} (got "${env.FLOWGRAPH_AUTH_MODE}")`);
  }
  const issuer = env.FLOWGRAPH_OIDC_ISSUER?.trim();
  const token = env.FLOWGRAPH_AUTH_TOKEN;
  const disabled = envFlag(env, "FLOWGRAPH_AUTH_DISABLED");
  const set = [issuer ? "FLOWGRAPH_OIDC_ISSUER" : "", token ? "FLOWGRAPH_AUTH_TOKEN" : "", disabled ? "FLOWGRAPH_AUTH_DISABLED" : ""].filter(Boolean);
  // FLOWGRAPH_AUTH_DISABLED has always won over FLOWGRAPH_AUTH_TOKEN; OIDC mixes with neither.
  if (issuer && set.length > 1) throw new Error(`FLOWGRAPH_OIDC_ISSUER cannot be combined with ${set.slice(1).join(", ")}`);
  const inferred: AuthMode = issuer ? "oidc" : disabled ? "none" : "token";
  const mode = (rawMode as AuthMode | undefined) ?? inferred;
  if (rawMode && rawMode !== inferred) {
    const needs = { oidc: "FLOWGRAPH_OIDC_ISSUER", token: "FLOWGRAPH_AUTH_TOKEN", none: "FLOWGRAPH_AUTH_DISABLED=1" }[mode];
    throw new Error(`FLOWGRAPH_AUTH_MODE=${mode} needs ${needs}${set.length ? ` (got ${set.join(", ")})` : ""}`);
  }
  const auth: ServerAuthConfig = { mode, explicit: Boolean(rawMode), insecureDev };
  if (mode !== "oidc") return auth;

  checkHttpsUrl("FLOWGRAPH_OIDC_ISSUER", issuer!, insecureDev);
  const audience = envList(env, "FLOWGRAPH_OIDC_AUDIENCE");
  if (audience.length === 0) throw new Error("FLOWGRAPH_OIDC_AUDIENCE is required with FLOWGRAPH_OIDC_ISSUER (the API audience your issuer puts in aud)");
  const algorithms = envList(env, "FLOWGRAPH_OIDC_ALGORITHMS");
  const algs = algorithms.length ? algorithms : [...DEFAULT_OIDC_ALGORITHMS];
  const secret = env.FLOWGRAPH_OIDC_SHARED_SECRET;
  for (const a of algs) {
    if (a.toLowerCase() === "none") throw new Error("FLOWGRAPH_OIDC_ALGORITHMS may not include none");
    if (!ASYMMETRIC_ALGORITHMS.includes(a) && !SHARED_SECRET_ALGORITHMS.includes(a)) {
      throw new Error(`FLOWGRAPH_OIDC_ALGORITHMS: unknown algorithm "${a}"`);
    }
  }
  const hs = algs.filter((a) => SHARED_SECRET_ALGORITHMS.includes(a));
  if (hs.length && hs.length !== algs.length) throw new Error("FLOWGRAPH_OIDC_ALGORITHMS cannot mix HS* with asymmetric algorithms");
  if (hs.length && !secret) throw new Error(`FLOWGRAPH_OIDC_ALGORITHMS=${hs.join(",")} needs FLOWGRAPH_OIDC_SHARED_SECRET`);
  if (!hs.length && secret) throw new Error("FLOWGRAPH_OIDC_SHARED_SECRET is only used with FLOWGRAPH_OIDC_ALGORITHMS=HS256 (or HS384 / HS512)");
  if (secret && Buffer.byteLength(secret, "utf8") < 32) throw new Error("FLOWGRAPH_OIDC_SHARED_SECRET must be at least 32 bytes");
  const skewRaw = env.FLOWGRAPH_OIDC_CLOCK_SKEW_SECONDS?.trim();
  let clockToleranceSec = DEFAULT_CLOCK_TOLERANCE_SEC;
  if (skewRaw) {
    clockToleranceSec = Number(skewRaw);
    if (!/^\d+$/.test(skewRaw) || clockToleranceSec > MAX_CLOCK_TOLERANCE_SEC) {
      throw new Error(`FLOWGRAPH_OIDC_CLOCK_SKEW_SECONDS must be a whole number from 0 to ${MAX_CLOCK_TOLERANCE_SEC} (got "${skewRaw}")`);
    }
  }
  const jwksUri = env.FLOWGRAPH_OIDC_JWKS_URI?.trim();
  if (jwksUri) checkHttpsUrl("FLOWGRAPH_OIDC_JWKS_URI", jwksUri, insecureDev);
  const nameClaims = envList(env, "FLOWGRAPH_OIDC_NAME_CLAIMS");
  const projectClaim = env.FLOWGRAPH_OIDC_PROJECT_CLAIM?.trim();
  const oidc: OidcAuthConfig = {
    issuer: issuer!,
    audience,
    algorithms: algs,
    clockToleranceSec,
    ...(jwksUri ? { jwksUri } : {}),
    ...(secret ? { sharedSecret: secret } : {}),
    claims: {
      org: env.FLOWGRAPH_OIDC_ORG_CLAIM?.trim() || "org_id",
      ...(projectClaim ? { project: projectClaim } : {}),
      roles: env.FLOWGRAPH_OIDC_ROLES_CLAIM?.trim() || "roles",
      teams: env.FLOWGRAPH_OIDC_TEAMS_CLAIM?.trim() || "groups",
      displayName: nameClaims.length ? nameClaims : ["name", "preferred_username", "email"],
    },
    trust: { roles: envList(env, "FLOWGRAPH_OIDC_TRUSTED_ROLES"), teams: envList(env, "FLOWGRAPH_OIDC_TRUSTED_TEAMS") },
    ...(env.FLOWGRAPH_ORG?.trim() ? { defaultOrg: env.FLOWGRAPH_ORG.trim() } : {}),
    defaultProject: env.FLOWGRAPH_PROJECT?.trim() || "local",
  };
  auth.oidc = oidc;
  return auth;
}

function envFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function defaultServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const config: ServerConfig = {
    host: env.FLOWGRAPH_HOST ?? "0.0.0.0",
    port: Number(env.FLOWGRAPH_PORT ?? env.PORT ?? 8080),
    graphStoreDir: env.FLOWGRAPH_GRAPH_STORE ?? "/tmp/flowgraph-graphs",
    eventBufferSize: Number(env.FLOWGRAPH_EVENT_BUFFER ?? 5000),
    authDisabled: envFlag(env, "FLOWGRAPH_AUTH_DISABLED"),
    auth: authConfigFromEnv(env),
    maxBodyBytes: envInt(env, "FLOWGRAPH_MAX_BODY_BYTES", 2_000_000),
    maxConcurrentRuns: envInt(env, "FLOWGRAPH_MAX_CONCURRENT_RUNS", 16),
  };
  if (env.FLOWGRAPH_AUTH_TOKEN) config.authToken = env.FLOWGRAPH_AUTH_TOKEN;
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  const memBackend = (env.FLOWGRAPH_MEMORY_BACKEND?.trim().toLowerCase() || "memory") as ServerMemoryBackend;
  if (!MEMORY_BACKENDS.includes(memBackend)) {
    throw new Error(`FLOWGRAPH_MEMORY_BACKEND must be one of ${MEMORY_BACKENDS.join(" | ")} (got "${env.FLOWGRAPH_MEMORY_BACKEND}")`);
  }
  config.memory = { backend: memBackend };
  if (env.FLOWGRAPH_MEMORY_SQLITE_PATH?.trim()) config.memory.sqlitePath = env.FLOWGRAPH_MEMORY_SQLITE_PATH.trim();
  if (env.FLOWGRAPH_ORG?.trim()) {
    config.memory.identity = {
      org: env.FLOWGRAPH_ORG.trim(),
      project: env.FLOWGRAPH_PROJECT?.trim() || "local",
      ...(env.FLOWGRAPH_USER?.trim() ? { user: env.FLOWGRAPH_USER.trim() } : {}),
    };
  }
  const sweepRaw = env.FLOWGRAPH_MEMORY_SWEEP_MS?.trim();
  if (sweepRaw) {
    const sweepMs = Number(sweepRaw);
    if (!/^\d+$/.test(sweepRaw) || sweepMs < 1_000 || sweepMs > MEMORY_SWEEP_MAX_INTERVAL_MS) {
      throw new Error(
        `FLOWGRAPH_MEMORY_SWEEP_MS must be a whole number of milliseconds from 1000 to ${MEMORY_SWEEP_MAX_INTERVAL_MS} (about 24.8 days) ` +
          `(got "${env.FLOWGRAPH_MEMORY_SWEEP_MS}")`,
      );
    }
    config.memory.sweepIntervalMs = sweepMs;
  }
  const lockRaw = env.FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS?.trim();
  if (lockRaw) {
    if (!/^\d+$/.test(lockRaw) || !Number.isSafeInteger(Number(lockRaw))) {
      throw new Error(`FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS must be a whole number of milliseconds (got "${env.FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS}")`);
    }
    config.setupLockTimeoutMs = Number(lockRaw);
  }
  const allowHosts = (env.FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (const h of allowHosts) {
    if (!/^(\*\.)?[A-Za-z0-9.-]+(:\d+)?$|^\[[0-9A-Fa-f:.]+\](:\d+)?$/.test(h)) {
      throw new Error(`FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS: "${h}" is not host, host:port or *.domain`);
    }
  }
  if (allowHosts.length) config.untrustedHttpAllowHosts = allowHosts;
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (region) config.awsRegion = region;
  if (env.FLOWGRAPH_CONNECT_URL?.trim()) config.connectUrl = env.FLOWGRAPH_CONNECT_URL.trim();
  if (env.FLOWGRAPH_CONNECT_TOKEN?.trim()) config.connectToken = env.FLOWGRAPH_CONNECT_TOKEN.trim();
  const allowedModels = (env.FLOWGRAPH_VOICE_ALLOWED_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  config.voice = {
    allowUnauthenticated: envFlag(env, "FLOWGRAPH_VOICE_ALLOW_UNAUTHENTICATED"),
    ...(allowedModels.length ? { allowedModels } : {}),
  };
  return config;
}
