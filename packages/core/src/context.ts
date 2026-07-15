/**
 * RunContext — threaded through compilation and execution.
 */

import type { EventBus, EventType } from "./events.js";
import type { HookBus } from "./hooks/bus.js";
import type { McpHub } from "./mcp/types.js";
import type { SecretProvider } from "./secrets.js";
import type { BaseStore } from "@langchain/langgraph";

export type { SecretProvider };

/** How a HITL interrupt should be presented and answered. */
export type InterruptKind = "approval" | "question" | "choice" | "custom";

export interface RunMeta {
  runId: string;
  threadId?: string | undefined;
  startedAt: string;
  graph: string;
  labels?: Record<string, string> | undefined;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface RunConfig {
  vars?: Record<string, unknown> | undefined;
  defaults?: {
    provider?: string | undefined;
    model?: string | undefined;
    timeout?: string | undefined;
  } | undefined;
  onInterrupt?: "prompt" | "fail" | "approve" | "webhook" | undefined;
  maxRetries?: number | undefined;
  cwd?: string | undefined;
  /** Skill alias map: alias → path/package */
  skills?: Record<string, string> | undefined;
  /** Agent-definition alias map: alias → path/package */
  agents?: Record<string, string> | undefined;
  /** Subgraph alias map: alias → child graph path/package */
  subgraphs?: Record<string, string> | undefined;
}

export interface BudgetState {
  maxUSD?: number | undefined;
  maxTokens?: number | undefined;
  onExceed: "interrupt" | "fail" | "warn";
  usedTokens: number;
  usedUSD: number;
}

export interface RunContext {
  meta: RunMeta;
  config: RunConfig;
  secrets: SecretProvider;
  events: EventBus;
  logger: Logger;
  signal?: AbortSignal | undefined;
  workspace: string;
  /** Run-level token/cost budget tracker, shared across agent nodes. */
  budget?: BudgetState | undefined;
  /** Hook bus for lifecycle interception (mutate/veto/route/retry/interrupt). */
  hooks?: HookBus | undefined;
  /** MCP hub for deterministic mcp nodes and agent MCP tools. */
  mcp?: McpHub | undefined;
  /** Cross-thread long-term memory (LangGraph BaseStore). */
  store?: BaseStore | undefined;
}

export function createLogger(events: EventBus, graphName: string): Logger {
  const log = (level: string, msg: string, data?: Record<string, unknown>) => {
    events.emit("log", { level, msg, ...data }, {});
    if (process.env["FLOWGRAPH_LOG_LEVEL"] !== "silent") {
      const out = `[${graphName}] ${level.toUpperCase()} ${msg}`;
      if (level === "error") console.error(out, data ?? "");
      else if (level === "warn") console.warn(out, data ?? "");
      else if (process.env["FLOWGRAPH_LOG_LEVEL"] !== "warn") console.log(out, data ?? "");
    }
  };
  return {
    debug: (msg, data) => log("debug", msg, data),
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
  };
}

/** Context available inside a node's run() call */
export interface NodeRunContext extends RunContext {
  nodeId: string;
  nodeType: string;
  attempt: number;
  render(template: string, extra?: Record<string, unknown>): unknown;
  emit(type: EventType, data: unknown): void;
  /**
   * Raise a human-in-the-loop interrupt. Suspends execution and checkpoints
   * state. On resume, returns the value supplied to `Command({ resume })`.
   */
  interrupt<T = unknown>(payload: {
    reason: string;
    data?: unknown;
    kind?: InterruptKind;
  }): T;
  /**
   * Run `fn` at most once per `key` per thread. The result is recorded in
   * graph state so side effects don't re-fire when a node replays on resume.
   */
  once<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
}
