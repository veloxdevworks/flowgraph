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
 * import { createLangChainProvider } from "@veloxdevworks/flowgraph-core";
 * const provider = createLangChainProvider(new ChatOpenAI({ model: "gpt-4o" }));
 * const compiled = await compileGraph(spec, { providers: [provider] });
 */

import {
  SystemMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
  type AIMessage,
} from "@langchain/core/messages";
import type {
  ProviderAdapter,
  AgentRequest,
  AgentResult,
  ProviderRunContext,
  AgentStep,
  TokenUsage,
} from "../types.js";

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

      for (let step = 0; step < maxSteps; step++) {
        const ai = await bound.invoke(messages, { signal: ctx.signal });
        final = ai;
        messages.push(ai);
        accumulateUsage(usage, ai);

        const toolCalls = (ai.tool_calls ?? []) as Array<{ name: string; args: unknown; id?: string }>;
        if (toolCalls.length === 0) break;

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
      }

      usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      ctx.emit("usage", usage);

      const content = extractText(final);
      let output: unknown = { text: content };
      if (req.schema) {
        output = tryParseJson(content) ?? { text: content };
      }

      return { output, steps, usage, stopReason: "done" };
    },
  };
}

// ---------------------------------------------------------------------------

function buildTool(
  spec: { name: string; description?: string; schema?: Record<string, unknown> },
  ctx: ProviderRunContext,
): Record<string, unknown> {
  // A DynamicStructuredTool-compatible plain object. LangChain models accept
  // tool definitions with name/description/schema and a func.
  return {
    name: spec.name,
    description: spec.description ?? `flowgraph tool: ${spec.name}`,
    schema: spec.schema ?? { type: "object", properties: {}, additionalProperties: true },
    func: async (args: unknown) => {
      const result = await ctx.invokeTool(spec.name, args);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  };
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
