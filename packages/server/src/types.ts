import type { FlowgraphEvent, RunResult, StateSnapshot } from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";

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

export interface GraphMeta {
  threadId: string;
  storedAt: string;
  updatedAt: string;
  label?: string;
  graphName?: string;
  status?: RunStatus;
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
  /** Postgres URL. When unset, use in-memory checkpointer (local smoke only). */
  databaseUrl?: string;
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
    maxBodyBytes: envInt(env, "FLOWGRAPH_MAX_BODY_BYTES", 2_000_000),
    maxConcurrentRuns: envInt(env, "FLOWGRAPH_MAX_CONCURRENT_RUNS", 16),
  };
  if (env.FLOWGRAPH_AUTH_TOKEN) config.authToken = env.FLOWGRAPH_AUTH_TOKEN;
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
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
