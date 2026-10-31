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

// Minimal structural type for a LangChain chat model (avoids a hard type dep
// on a specific @langchain/core version's class shape).
export interface ChatModelLike {
  invoke(input: BaseMessage[], options?: unknown): Promise<AIMessage>;
  bindTools?(tools: unknown[], kwargs?: unknown): ChatModelLike;
  withStructuredOutput?(schema: unknown, config?: unknown): { invoke(input: BaseMessage[], options?: unknown): Promise<unknown> };
}

export interface LangChainProviderOptions {
  name?: string;
  /** Known model ids for validation/autocomplete. */
  models?: string[];
}

export function createLangChainProvider(
  model: ChatModelLike,
  options: LangChainProviderOptions = {},
): ProviderAdapter {
  const name = options.name ?? "langchain";

  return {
    name,
    capabilities: {
      toolCalling: typeof model.bindTools === "function",
      contextMessages: true,
      structuredOutput: typeof model.withStructuredOutput === "function",
      streaming: false,
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
      if (ctx.context) return runWithContext(model, req, ctx, ctx.context);
      const messages: BaseMessage[] = [];
      if (req.system) messages.push(new SystemMessage(req.system));
      messages.push(new HumanMessage(req.prompt));

      // Structured output without tools → single constrained call.
      if (req.schema && req.tools.length === 0 && typeof model.withStructuredOutput === "function") {
        const structured = model.withStructuredOutput(req.schema);
        const output = await structured.invoke(messages, { signal: ctx.signal });
        return { output, messages: [], steps: [], stopReason: "done" };
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
          : await bound.invoke(messages, { signal: ctx.signal });
        if (!(cached instanceof AIMessage)) ctx.replay?.set(llmIndex, ai);
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
      ctx.emit("usage", usage);

      const content = extractText(final);
      let output: unknown = { text: content };
      if (req.schema) {
        output = tryParseJson(content) ?? { text: content };
      }

      return { output, steps, usage, stopReason };
    },
  };
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
  const toLc = (m: ContextMessage): BaseMessage => {
    const own = lcOf.get(m);
    if (own) return own;
    let c = converted.get(m);
    if (!c) {
      c = toLangChainMessage(m);
      converted.set(m, c);
    }
    return c;
  };
  const build = async (): Promise<BaseMessage[]> => {
    const f = await cm.fit(loop);
    const out: BaseMessage[] = [];
    if (f.system) out.push(new SystemMessage(f.system));
    for (const m of f.messages) out.push(toLc(m));
    return out;
  };

  if (req.schema && req.tools.length === 0 && typeof model.withStructuredOutput === "function") {
    const structured = model.withStructuredOutput(req.schema);
    const output = await structured.invoke(await build(), { signal: ctx.signal });
    return { output, messages: [], steps: [], stopReason: "done", turn: [] };
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
      ai = await bound.invoke(input, { signal: ctx.signal });
      ctx.replay?.set(llmIndex, ai);
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
  ctx.emit("usage", usage);

  const content = extractText(final);
  let output: unknown = { text: content };
  if (req.schema) output = tryParseJson(content) ?? { text: content };
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

function extractText(ai: AIMessage | undefined): string {
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
