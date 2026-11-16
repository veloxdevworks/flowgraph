/**
 * LangChain ChatModel provider adapter for flowgraph.
 *
 * Wraps any LangChain `BaseChatModel` (e.g. @langchain/openai, @langchain/anthropic)
 * and implements the hub-and-spoke agent loop: bind flowgraph tools, call the
 * model, execute tool calls, loop until done. Structured output via
 * `withStructuredOutput` when a schema is provided.
 *
 * @example
 * import { ChatOpenAI } from "@langchain/openai";
 * import { createLangChainProvider } from "@flowgraph/core";
 * const provider = createLangChainProvider(new ChatOpenAI({ model: "gpt-4o" }));
 * const compiled = await compileGraph(spec, { providers: [provider] });
 */

import {
  SystemMessage,
  HumanMessage,
  ToolMessage,
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type {
  ProviderAdapter,
  AgentRequest,
  AgentResult,
  ProviderRunContext,
  AgentStep,
  TokenUsage,
} from "../types.js";
import type { ContextMessage, ProviderContextManager } from "../../context/types.js";
import { toLangChainMessage } from "../../context/messages.js";
import { redactProviderErrors } from "../redact-errors.js";
import { rejectedRequestUsage } from "../../usage/rejected-request.js";
import { validateAgentOutput } from "../../runtime/agent-output.js";
import { assertImageBatch, imageContentBlocks, imageError } from "../images.js";

// Minimal structural type for a LangChain chat model (avoids a hard type dep
// on a specific @langchain/core version's class shape).
export interface ChatModelLike {
  invoke(input: BaseMessage[], options?: unknown): Promise<AIMessage>;
  stream?(input: BaseMessage[], options?: unknown): AsyncIterable<AIMessageChunk> | Promise<AsyncIterable<AIMessageChunk>>;
  bindTools?(tools: unknown[], kwargs?: unknown): ChatModelLike;
  /** LangChain BaseChatModel.bind — used to apply a node model override and maxTokens. */
  bind?(kwargs: Record<string, unknown>): ChatModelLike;
  withStructuredOutput?(schema: unknown, config?: unknown): { invoke(input: BaseMessage[], options?: unknown): Promise<unknown> };
}

/** Call options for a node model override and `maxTokens`. */
export function langchainCallOptions(req: AgentRequest): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (req.model) options.model = req.model;
  if (req.maxTokens !== undefined) options.maxTokens = req.maxTokens;
  return options;
}

function modelForRequest(model: ChatModelLike, req: AgentRequest): ChatModelLike {
  const options = langchainCallOptions(req);
  if (Object.keys(options).length === 0) return model;
  if (typeof model.bind === "function") return model.bind(options);
  return model;
}

function invokeOptions(req: AgentRequest, signal: AbortSignal): Record<string, unknown> {
  return { signal, ...langchainCallOptions(req) };
}

const REQUEST_TIMEOUT = Symbol("modelRequestTimeout");
export interface LangChainProviderOptions {
  /** Per-model-request deadline; defaults to two minutes. null disables it. */
  requestTimeoutMs?: number | null;
  name?: string;
  /** Known model ids for validation/autocomplete. */
  models?: string[];
}

async function modelMessage(message: ContextMessage, ctx: ProviderRunContext): Promise<BaseMessage> {
  if (!message.images?.length) return toLangChainMessage(message);
  if (message.role !== "user") throw imageError("IMAGE_INPUT_INVALID", "Only user messages can carry image inputs");
  return new HumanMessage({
    content: [{ type: "text", text: message.content }, ...await imageContentBlocks(message.images, ctx.node)],
    ...(message.id !== undefined ? { id: message.id } : {}),
    ...(message.name !== undefined ? { name: message.name } : {}),
  });
}

export function createLangChainProvider(
  model: ChatModelLike,
  options: LangChainProviderOptions = {},
): ProviderAdapter {
  const name = options.name ?? "langchain";
  if (options.requestTimeoutMs !== undefined && options.requestTimeoutMs !== null && (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) throw new Error("requestTimeoutMs must be positive or null");

  return redactProviderErrors({
    name,
    capabilities: {
      imageInput: true,
      toolCalling: typeof model.bindTools === "function",
      contextMessages: true,
      structuredOutput: typeof model.withStructuredOutput === "function",
      streaming: typeof model.stream === "function",
      callAccounting: true,
      ...(options.models ? { models: options.models } : {}),
    },

    validate(config: unknown) {
      const diags: Array<{ severity: "error" | "warning"; message: string }> = [];
      const tools = (config as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? [];
      for (const t of tools) {
        if ("builtin" in t) {
          diags.push({
            severity: "warning",
            message: `LangChain provider has no provider-native builtin tools; "${JSON.stringify(t.builtin)}" will not work.`,
          });
        }
      }
      return diags;
    },

    async run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult> {
      ctx = Object.assign({...ctx}, {[REQUEST_TIMEOUT]: options.requestTimeoutMs === undefined ? 120000 : options.requestTimeoutMs});
      if (ctx.context) return runWithContext(model, req, ctx, ctx.context);
      const messages: BaseMessage[] = [];
      if (req.system) messages.push(new SystemMessage(req.system));
      messages.push(await modelMessage({ role: "user", content: req.prompt, images: req.images }, ctx));

      // Structured output without tools → single constrained call.
      if (req.schema && req.tools.length === 0 && typeof model.withStructuredOutput === "function") {
        const { output, usage } = await constrainedOutput(model, req, ctx, messages);
        return { output, usage, messages: [], steps: [], stopReason: "done" };
      }

      const lcTools = req.tools.map((spec) => buildTool(spec, ctx));
      const bound: ChatModelLike =
        lcTools.length > 0 && typeof model.bindTools === "function"
          ? model.bindTools(lcTools)
          : model;

      const steps: AgentStep[] = [];
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const maxSteps = req.maxSteps ?? 10;
      let final: AIMessage | undefined;
      let stopReason: AgentResult["stopReason"] = "done";

      for (let step = 0; step < maxSteps; step++) {
        const llmIndex = `llm:${step}`;
        const cached = ctx.replay?.get(llmIndex);
        const ai = cached instanceof AIMessage
          ? cached
          : await invokeModel(bound, messages, req, ctx);
        if (!(cached instanceof AIMessage)) await ctx.replay?.set(llmIndex, ai);
        final = ai;
        messages.push(ai);
        accumulateUsage(usage, ai);

        const toolCalls = (ai.tool_calls ?? []) as Array<{ name: string; args: unknown; id?: string }>;
        if (toolCalls.length === 0) {
          stopReason = "done";
          break;
        }

        for (const call of toolCalls) {
          ctx.emit("tool.call", { tool: call.name, args: call.args });
          const result = await ctx.invokeTool(call.name, call.args);
          ctx.emit("tool.result", { tool: call.name, result });
          steps.push({ type: "tool_call", tool: call.name, args: call.args, result });
          messages.push(
            new ToolMessage({
              content: typeof result === "string" ? result : JSON.stringify(result),
              tool_call_id: call.id ?? call.name,
            }),
          );
        }

        if (step === maxSteps - 1) stopReason = "maxSteps";
      }

      usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

      const content = extractText(final);
      let output: unknown = { text: content };
      if (req.schema && stopReason === "done") {
        if (model.withStructuredOutput) {
          const result = await constrainedOutput(model, req, ctx, messages);
          output = result.output;
          addUsage(usage, result.usage);
        } else {
          output = tryParseJson(content);
          validateAgentOutput(output, req.schema, `provider ${name} schema`);
        }
      }

      return { output, steps, usage, stopReason };
    },
  });
}

// ---------------------------------------------------------------------------

/**
 * The agent loop under a context budget: before every model call the
 * manager picks which history, prompt and loop messages to send. Loop
 * messages keep their original LangChain objects; history is converted once.
 */
async function runWithContext(
  model: ChatModelLike,
  req: AgentRequest,
  ctx: ProviderRunContext,
  cm: ProviderContextManager,
): Promise<AgentResult> {
  const loop: ContextMessage[] = [];
  const lcOf = new Map<ContextMessage, BaseMessage>();
  const converted = new WeakMap<ContextMessage, BaseMessage>();
  const toLc = async (m: ContextMessage): Promise<BaseMessage> => {
    const own = lcOf.get(m);
    if (own) return own;
    let c = converted.get(m);
    if (!c) {
      c = await modelMessage(m, ctx);
      converted.set(m, c);
    }
    return c;
  };
  const build = async (): Promise<BaseMessage[]> => {
    const f = await cm.fit(loop);
    assertImageBatch(f.messages.flatMap(message => message.images ?? []));
    const out: BaseMessage[] = [];
    if (f.system) out.push(new SystemMessage(f.system));
    for (const m of f.messages) out.push(await toLc(m));
    return out;
  };

  if (req.schema && req.tools.length === 0 && typeof model.withStructuredOutput === "function") {
    const { output, usage } = await constrainedOutput(model, req, ctx, await build());
    return { output, usage, messages: [], steps: [], stopReason: "done", turn: [] };
  }

  const lcTools = req.tools.map((spec) => buildTool(spec, ctx));
  const bound: ChatModelLike =
    lcTools.length > 0 && typeof model.bindTools === "function" ? model.bindTools(lcTools) : model;

  const steps: AgentStep[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const maxSteps = req.maxSteps ?? 10;
  let final: AIMessage | undefined;
  let stopReason: AgentResult["stopReason"] = "done";

  for (let step = 0; step < maxSteps; step++) {
    const llmIndex = `llm:${step}`;
    const cached = ctx.replay?.get(llmIndex);
    // Fit even when the response is replayed, so the window (and any summary
    // it makes) goes through the same steps as the original run.
    const input = await build();
    let ai: AIMessage;
    if (cached instanceof AIMessage) {
      ai = cached;
    } else {
      ai = await invokeModel(bound, input, req, ctx);
      await ctx.replay?.set(llmIndex, ai);
    }
    final = ai;
    accumulateUsage(usage, ai);
    const toolCalls = (ai.tool_calls ?? []) as Array<{ name: string; args: unknown; id?: string }>;
    // Every call needs an id its result can answer; give id-less calls distinct, replay-stable ones.
    const callIds = toolCalls.map((c, k) => c.id || `${c.name}_${step}_${k}`);
    const aiMsg: ContextMessage = {
      role: "assistant",
      content: extractText(ai),
      ...(typeof ai.id === "string" ? { id: ai.id } : {}),
      ...(toolCalls.length
        ? { toolCalls: toolCalls.map((c, k) => ({ id: callIds[k]!, name: c.name, args: c.args })) }
        : {}),
    };
    loop.push(aiMsg);
    // Send the vendor's own message unless ids were filled in (then send the calls with those ids).
    if (toolCalls.every((c) => !!c.id)) lcOf.set(aiMsg, ai);
    if (toolCalls.length === 0) {
      stopReason = "done";
      break;
    }

    for (const [k, call] of toolCalls.entries()) {
      ctx.emit("tool.call", { tool: call.name, args: call.args });
      const result = await ctx.invokeTool(call.name, call.args);
      ctx.emit("tool.result", { tool: call.name, result });
      steps.push({ type: "tool_call", tool: call.name, args: call.args, result });
      const content = cm.capToolResult(typeof result === "string" ? result : JSON.stringify(result));
      const toolMsg: ContextMessage = { role: "tool", content, toolCallId: callIds[k]! };
      loop.push(toolMsg);
      lcOf.set(toolMsg, new ToolMessage({ content, tool_call_id: callIds[k]! }));
    }

    if (step === maxSteps - 1) stopReason = "maxSteps";
  }

  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

  const content = extractText(final);
  let output: unknown = { text: content };
  if (req.schema && stopReason === "done") {
    if (model.withStructuredOutput) {
      const result = await constrainedOutput(model, req, ctx, await build());
      output = result.output;
      addUsage(usage, result.usage);
      loop.push({ role: "assistant", content: JSON.stringify(output) });
    } else {
      output = tryParseJson(content);
      validateAgentOutput(output, req.schema, "LangChain provider schema");
    }
  }
  return { output, steps, usage, stopReason, turn: loop };
}

function buildTool(
  spec: { name: string; description?: string; schema?: Record<string, unknown> },
  ctx: ProviderRunContext,
): DynamicStructuredTool {
  // DynamicStructuredTool is required for Bedrock Converse bindTools (plain
  // { name, description, schema, func } objects are rejected by some vendors).
  return new DynamicStructuredTool({
    name: spec.name,
    description: spec.description ?? `flowgraph tool: ${spec.name}`,
    schema: spec.schema ?? { type: "object", properties: {}, additionalProperties: true },
    func: async (args: unknown) => {
      const result = await ctx.invokeTool(spec.name, args);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  });
}

function accumulateUsage(usage: TokenUsage, ai: AIMessage): void {
  const meta = (ai as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
  if (meta) {
    usage.inputTokens = (usage.inputTokens ?? 0) + (meta.input_tokens ?? 0);
    usage.outputTokens = (usage.outputTokens ?? 0) + (meta.output_tokens ?? 0);
  }
}

function extractText(ai: { content: unknown } | undefined): string {
  if (!ai) return "";
  const content = ai.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("");
  }
  return String(content ?? "");
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

async function constrainedOutput(model: ChatModelLike, req: AgentRequest, ctx: ProviderRunContext, messages: BaseMessage[]): Promise<{ output: unknown; usage: TokenUsage }> {
  const cached = ctx.replay?.get("llm:structured");
  if (cached && typeof cached === "object" && "output" in cached) return cached as { output: unknown; usage: TokenUsage };
  const invoke = async () => {
    const result = await withHeartbeat(ctx, signal => modelForRequest(model, req).withStructuredOutput!(req.schema, { includeRaw: true, strict: false }).invoke(messages, invokeOptions(req, signal)));
    const wrapped = result && typeof result === "object" && Object.hasOwn(result, "parsed") && Object.hasOwn(result, "raw")
      ? result as { parsed: unknown; raw: AIMessage; parsing_error?: unknown } : undefined;
    return { output: wrapped ? wrapped.parsed : result, usage: wrapped?.raw ? modelUsage(wrapped.raw) : undefined };
  };
  const result = ctx.meterCall
    ? await ctx.meterCall(invoke, { usage: value => value.usage, errorUsage: rejectedRequestUsage })
    : await invoke();
  if (!ctx.meterCall && result.usage) ctx.emit("usage", result.usage);
  const saved = { output: result.output, usage: result.usage ?? {} };
  await ctx.replay?.set("llm:structured", saved);
  validateAgentOutput(result.output, req.schema!, `agent node "${ctx.node.nodeId}" schema`);
  return saved;
}

function modelUsage(ai: AIMessage): TokenUsage | undefined {
  const meta = (ai as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }).usage_metadata;
  return meta ? {
    ...(meta.input_tokens === undefined ? {} : { inputTokens: meta.input_tokens }),
    ...(meta.output_tokens === undefined ? {} : { outputTokens: meta.output_tokens }),
    ...(meta.total_tokens === undefined ? {} : { totalTokens: meta.total_tokens }),
  } : undefined;
}
async function invokeModel(model: ChatModelLike, input: BaseMessage[], req: AgentRequest, ctx: ProviderRunContext): Promise<AIMessage> {
  let responseStarted = false;
  let partialUsage: TokenUsage | undefined;
  const bound = modelForRequest(model, req);
  const invoke = () => withHeartbeat(ctx, async signal => {
    const options = invokeOptions(req, signal);
    if (!req.streaming || !bound.stream) return bound.invoke(input, options);
    let combined: AIMessageChunk | undefined;
    for await (const chunk of await bound.stream(input, options)) {
      responseStarted = true;
      const text = extractText(chunk);
      if (text) ctx.emit("token", { text });
      combined = combined ? combined.concat(chunk) : chunk;
      partialUsage = modelUsage(combined as unknown as AIMessage);
    }
    if (!combined) throw new Error("Model stream ended without a response");
    return new AIMessage({ content: combined.content, tool_calls: combined.tool_calls ?? [],
      ...(combined.usage_metadata ? { usage_metadata: combined.usage_metadata } : {}) });
  });
  const ai = ctx.meterCall ? await ctx.meterCall(invoke, { usage: modelUsage, errorUsage: error => responseStarted ? partialUsage : rejectedRequestUsage(error), errorOutcomeUnknown: () => responseStarted }) : await invoke();
  if (!ctx.meterCall) { const usage = modelUsage(ai); if (usage) ctx.emit("usage", usage); }
  return ai;
}

function addUsage(total: TokenUsage, inc: TokenUsage): void {
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUSD"] as const) {
    if (inc[key] !== undefined) total[key] = (total[key] ?? 0) + inc[key]!;
  }
}

/** Waiting on an SDK call should remain visible, including structured-output calls. */
async function withHeartbeat<T>(ctx: ProviderRunContext, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const started = Date.now();
  const timeoutMs = (ctx as ProviderRunContext & {[REQUEST_TIMEOUT]?: number|null})[REQUEST_TIMEOUT];
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal,controller.signal]) : controller.signal;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== null) {
    const ms=timeoutMs ?? 120000;
    deadline=setTimeout(()=>controller.abort(Object.assign(new Error(`Model request timed out after ${ms}ms; its provider outcome may need reconciliation`),{code:"MODEL_REQUEST_TIMEOUT",retryable:false})),ms);
    deadline.unref();
  }
  const timer=setInterval(()=>ctx.node.emit("custom.agent.waiting",{phase:"model",elapsedMs:Date.now()-started}),15000);
  timer.unref();
  let onAbort!:()=>void;
  const aborted=new Promise<never>((_resolve,reject)=>{
    onAbort=()=>{clearInterval(timer);reject(controller.signal.reason);};
    controller.signal.addEventListener("abort",onAbort,{once:true});
    if(controller.signal.aborted)onAbort();
  });
  const stopOnCallerAbort=()=>{clearInterval(timer);clearTimeout(deadline);};
  ctx.signal?.addEventListener("abort",stopOnCallerAbort,{once:true});
  try { signal.throwIfAborted(); return await Promise.race([invoke(signal),aborted]); }
  finally {clearTimeout(deadline);clearInterval(timer);controller.signal.removeEventListener("abort",onAbort);ctx.signal?.removeEventListener("abort",stopOnCallerAbort);}
}
