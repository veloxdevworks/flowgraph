/**
 * Provider abstraction for intelligent (agent) nodes.
 *
 * A ProviderAdapter runs a tool-calling agent loop. flowgraph normalizes a
 * node's tools into ToolSpecs and hands the adapter a ProviderRunContext that
 * can invoke those tools back through the runtime (events/contracts/HITL).
 */

import type { z } from "zod";
import type { MeteredCallOptions } from "../usage/ledger.js";
import type { NodeRunContext } from "../context.js";
import type { ProviderContextManager } from "../context/types.js";
import type { Artifact } from "@flowgraph/spec";

/** Immutable image input stored as an Artifact, never inline base64 in history. */
export type ImageAttachment = Artifact & { role: "image"; sha256: string };
export const DEFAULT_IMAGE_TOKENS = 1024;

export interface ProviderCapabilities {
  /** Can send first-class image attachments to a model. */
  imageInput?: boolean;
  /** Provider wraps every actual paid call with ctx.meterCall (replays are excluded). */
  callAccounting?: boolean;
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
  images?: ImageAttachment[] | undefined;
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
  images?: ImageAttachment[] | undefined;
  messages?: Message[] | undefined;
  tools: ToolSpec[];
  schema?: Record<string, unknown> | undefined;
  model?: string | undefined;
  /** `node` wins over the provider model. `default` applies only when that provider has no model of its own. */
  modelSource?: "node" | "default" | undefined;
  maxSteps?: number | undefined;
  maxTokens?: number | undefined;
  permission: "auto" | "ask" | "deny";
  streaming?: boolean | undefined;
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
  /** Persist admission and usage for an actual paid call; never wrap a replay. */
  meterCall?<T>(invoke: () => Promise<T>, options: MeteredCallOptions<T>): Promise<T>;
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
    set(index: string, value: unknown): void | Promise<void>;
  };
  /**
   * Context budget for this agent (present when with.context or
   * runtime.context applies). Providers that run their own tool loop call
   * `fit` before every model call and send what it returns.
   */
  context?: ProviderContextManager;
}

/** The node a provider `validate()` call is checking. */
export interface ProviderValidateNode {
  id: string;
  model?: string | undefined;
}

export interface ProviderAdapter {
  name: string;
  capabilities: ProviderCapabilities;
  run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult>;
  stream?(req: AgentRequest, ctx: ProviderRunContext): AsyncIterable<AgentEvent>;
  /**
   * Options the provider cannot honor. `node` names the node and the model it
   * asks for (node `model`, else `config.defaults.model`).
   */
  validate?(config: unknown, node?: ProviderValidateNode): Array<{ severity: "error" | "warning"; message: string }>;
}

export function defineProvider(adapter: ProviderAdapter): ProviderAdapter {
  return adapter;
}

/** Context passed to a provider plugin when instantiating a `kind: plugin` entry. */
export interface ProviderPluginContext {
  /** Provider key declared under `providers:`. */
  name: string;
  /** Optional default model from `providers.<name>.model`. */
  model?: string | undefined;
  /** Optional env var name from `providers.<name>.apiKeyEnv`. */
  apiKeyEnv?: string | undefined;
  /** Resolved API key value when `apiKeyEnv` is set and present in the host environment. */
  apiKey?: string | undefined;
}

/**
 * Factory for a `kind: plugin` provider entry. Validates `options` (via Zod
 * `optionsSchema` and/or `validateOptions`) before building the adapter.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ProviderPlugin<Options = any> {
  /** Plugin name matched by `providers.<name>.plugin` (or `<name>` when omitted). */
  name: string;
  /** Optional Zod schema validating `providers.<name>.options`. */
  optionsSchema?: z.ZodType<Options>;
  /** Optional semantic validator for `providers.<name>.options`. */
  validateOptions?: (
    options: Options,
    ctx: ProviderPluginContext,
  ) => Array<{ severity: "error" | "warning"; message: string }>;
  /** Create a ProviderAdapter configured with the validated options. */
  create(options: Options, ctx: ProviderPluginContext): ProviderAdapter | Promise<ProviderAdapter>;
}

export function defineProviderPlugin<Options = Record<string, unknown>>(
  plugin: ProviderPlugin<Options>,
): ProviderPlugin<Options> {
  return plugin;
}

export function isProviderPlugin(value: unknown): value is ProviderPlugin {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["name"] !== "string" || candidate["name"].trim().length === 0) return false;
  if (typeof candidate["create"] !== "function") return false;
  if ("run" in candidate && candidate["run"] !== undefined) return false;
  if (candidate["optionsSchema"] !== undefined) {
    const schema = candidate["optionsSchema"];
    if (
      schema == null ||
      typeof schema !== "object" ||
      typeof (schema as { safeParse?: unknown }).safeParse !== "function"
    ) {
      return false;
    }
  }
  if (candidate["validateOptions"] !== undefined && typeof candidate["validateOptions"] !== "function") {
    return false;
  }
  return true;
}
