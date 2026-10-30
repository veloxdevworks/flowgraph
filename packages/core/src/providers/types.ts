/**
 * Provider abstraction for intelligent (agent) nodes.
 *
 * A ProviderAdapter runs a tool-calling agent loop. flowgraph normalizes a
 * node's tools into ToolSpecs and hands the adapter a ProviderRunContext that
 * can invoke those tools back through the runtime (events/contracts/HITL).
 */

import type { NodeRunContext } from "../context.js";
import type { ProviderContextManager } from "../context/types.js";

export interface ProviderCapabilities {
  toolCalling: boolean;
  /**
   * The provider sends `AgentRequest.messages` as real chat turns. Otherwise
   * the agent node renders history into the prompt as a transcript.
   */
  contextMessages?: boolean;
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
  /** Stable id (history channels key messages by id). */
  id?: string;
  /** Assistant tool calls; each must be answered by a `tool` message with the same id. */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  /** For `tool` messages: the id of the call this result answers. */
  toolCallId?: string;
  /** flowgraph bookkeeping on system messages (e.g. the running summary). */
  meta?: Record<string, unknown>;
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
  /** Assistant and tool messages this run produced, in order (used by with.context.record: all). */
  turn?: Message[];
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
  /**
   * Per-node replay scratchpad. Providers record LLM responses (and the
   * agent node records tool results) so interrupt() resume does not re-bill
   * or re-execute completed steps.
   */
  replay?: {
    get(index: string): unknown | undefined;
    set(index: string, value: unknown): void;
  };
  /**
   * Context budget for this agent (present when with.context or
   * runtime.context applies). Providers that run their own tool loop call
   * `fit` before every model call and send what it returns.
   */
  context?: ProviderContextManager;
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
