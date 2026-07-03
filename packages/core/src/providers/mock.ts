/**
 * Built-in mock provider — deterministic, offline, no API keys.
 *
 * Useful for tests and local dry-runs. Two flavors:
 *   - `mockProvider`: echoes the prompt; if tools exist, calls the first one;
 *     if a schema is given, fills required string fields with the prompt.
 *   - `createScriptedProvider(name, handler)`: full control over AgentResult.
 */

import { defineProvider, type AgentRequest, type AgentResult, type ProviderAdapter, type ProviderRunContext } from "./types.js";

export function createScriptedProvider(
  name: string,
  handler: (req: AgentRequest, ctx: ProviderRunContext) => AgentResult | Promise<AgentResult>,
): ProviderAdapter {
  return defineProvider({
    name,
    capabilities: { toolCalling: true, structuredOutput: true, streaming: false },
    run: (req, ctx) => Promise.resolve(handler(req, ctx)),
  });
}

export const mockProvider: ProviderAdapter = defineProvider({
  name: "mock",
  capabilities: { toolCalling: true, structuredOutput: true, streaming: false },

  async run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult> {
    const steps: AgentResult["steps"] = [];
    const toolResults: Record<string, unknown> = {};

    // Hub & spoke: call each available tool once with the rendered prompt.
    const maxSteps = req.maxSteps ?? req.tools.length;
    for (const tool of req.tools.slice(0, maxSteps)) {
      ctx.emit("tool.call", { tool: tool.name });
      const result = await ctx.invokeTool(tool.name, { prompt: req.prompt });
      ctx.emit("tool.result", { tool: tool.name, result });
      steps.push({ type: "tool_call", tool: tool.name, args: { prompt: req.prompt }, result });
      toolResults[tool.name] = result;
    }

    let output: unknown;
    if (req.schema) {
      output = synthFromSchema(req.schema, req.prompt, toolResults);
    } else {
      output = { text: req.prompt, toolResults };
    }

    const usage = {
      inputTokens: estimateTokens(req.prompt + (req.system ?? "")),
      outputTokens: estimateTokens(JSON.stringify(output)),
    };
    ctx.emit("usage", usage);

    return {
      output,
      messages: [
        ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
        { role: "user" as const, content: req.prompt },
        { role: "assistant" as const, content: typeof output === "string" ? output : JSON.stringify(output) },
      ],
      steps,
      usage: { ...usage, totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) },
      stopReason: "done",
    };
  },
});

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function synthFromSchema(
  schema: Record<string, unknown>,
  prompt: string,
  toolResults: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema["properties"] as Record<string, { type?: string; enum?: unknown[] }> | undefined) ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (Array.isArray(def.enum) && def.enum.length > 0) {
      out[key] = def.enum[0];
      continue;
    }
    switch (def.type) {
      case "string": out[key] = prompt.slice(0, 120); break;
      case "number": out[key] = 0; break;
      case "boolean": out[key] = false; break;
      case "array": out[key] = Object.values(toolResults); break;
      case "object": out[key] = toolResults; break;
      default: out[key] = prompt.slice(0, 120);
    }
  }
  return out;
}
