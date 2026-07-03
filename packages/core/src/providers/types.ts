/**
 * Provider abstraction for intelligent (agent) nodes.
 *
 * A ProviderAdapter runs a tool-calling agent loop. flowgraph normalizes a
 * node's tools into ToolSpecs and hands the adapter a ProviderRunContext that
 * can invoke those tools back through the runtime (events/contracts/HITL).
 */

import type { NodeRunContext } from "../context.js";

export interface ProviderCapabilities {
  toolCalling: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  builtinTools?: string[];
  mcp?: boolean;
  models?: string[];
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export type ToolKind = "skill" | "node" | "function" | "builtin" | "mcp";

export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON-schema-ish description of the tool's arguments. */
  schema?: Record<string, unknown>;
  kind: ToolKind;
  /** Original reference (skill alias, node id, package, etc.). */
  ref?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUSD?: number;
}

export interface AgentStep {
  type: "thought" | "tool_call" | "tool_result" | "message";
  tool?: string;
  args?: unknown;
  result?: unknown;
  text?: string;
}

export interface AgentRequest {
  system?: string | undefined;
  prompt: string;
  messages?: Message[] | undefined;
  tools: ToolSpec[];
  schema?: Record<string, unknown> | undefined;
  model?: string | undefined;
  maxSteps?: number | undefined;
  maxTokens?: number | undefined;
  permission: "auto" | "ask" | "deny";
}

export interface AgentResult {
  output: unknown;
  messages?: Message[];
  steps?: AgentStep[];
  usage?: TokenUsage;
  stopReason: "done" | "maxSteps" | "interrupted" | "error";
}

export interface AgentEvent {
  type: "step" | "tool.call" | "tool.result" | "token" | "usage";
  data: unknown;
}

/** Context handed to a provider's run/stream. */
export interface ProviderRunContext {
  node: NodeRunContext;
  /** Invoke a normalized tool by name; routes through the flowgraph runtime. */
  invokeTool(name: string, args: unknown): Promise<unknown>;
  /**
   * Permission + hook gate for provider-native tools (not routed through invokeTool).
   * Returns possibly-mutated args; throws on deny/veto.
   */
  checkToolCall(name: string, args: unknown): Promise<unknown>;
  /** Hook-aware result mutation after a tool call completes. */
  reportToolResult(name: string, args: unknown, result: unknown): Promise<unknown>;
  emit(type: AgentEvent["type"], data: unknown): void;
  signal?: AbortSignal | undefined;
}

export interface ProviderAdapter {
  name: string;
  capabilities: ProviderCapabilities;
  run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult>;
  stream?(req: AgentRequest, ctx: ProviderRunContext): AsyncIterable<AgentEvent>;
  validate?(config: unknown): Array<{ severity: "error" | "warning"; message: string }>;
}

export function defineProvider(adapter: ProviderAdapter): ProviderAdapter {
  return adapter;
}
