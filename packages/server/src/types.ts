import type { FlowgraphEvent, RunResult, StateSnapshot } from "@veloxdevworks/flowgraph-core";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

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
   * Rejected when present: remote runs resolve credentials server-side.
   * Kept in the type so we can return a clear 400.
   */
  env?: Record<string, string>;
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
}

export interface ServerConfig {
  host: string;
  port: number;
  /** When set, require `Authorization: Bearer <token>`. Empty = no auth (dev). */
  authToken?: string;
  /** Postgres URL. When unset, use in-memory checkpointer (local smoke only). */
  databaseUrl?: string;
  /** Directory for persisted uploaded graphs. */
  graphStoreDir: string;
  /** Max events retained per thread for SSE replay. */
  eventBufferSize: number;
  /** AWS region hint for Bedrock (also set on process.env). */
  awsRegion?: string;
}

export function defaultServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const config: ServerConfig = {
    host: env.FLOWGRAPH_HOST ?? "0.0.0.0",
    port: Number(env.FLOWGRAPH_PORT ?? env.PORT ?? 8080),
    graphStoreDir: env.FLOWGRAPH_GRAPH_STORE ?? "/tmp/flowgraph-graphs",
    eventBufferSize: Number(env.FLOWGRAPH_EVENT_BUFFER ?? 5000),
  };
  if (env.FLOWGRAPH_AUTH_TOKEN) config.authToken = env.FLOWGRAPH_AUTH_TOKEN;
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (region) config.awsRegion = region;
  return config;
}
