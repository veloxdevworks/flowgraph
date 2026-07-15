/**
 * Cursor SDK provider adapter for flowgraph.
 */

import type {
  ProviderAdapter,
  AgentRequest,
  AgentResult,
  ProviderRunContext,
  AgentStep,
  TokenUsage,
  ToolSpec,
} from "@veloxdevworks/flowgraph-core";

export type CursorRuntime = "local" | "cloud";

export interface CursorAgentHandle {
  send(prompt: string, options?: Record<string, unknown>): Promise<CursorRunHandle>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CursorRunHandle {
  stream(): AsyncIterable<unknown>;
  wait(): Promise<{ status: string; result?: string; id?: string }>;
}

export type CursorAgentFactory = (options: Record<string, unknown>) => Promise<CursorAgentHandle>;

export interface CursorProviderOptions {
  name?: string;
  model?: string;
  runtime?: CursorRuntime;
  apiKey?: string;
  cwd?: string;
  models?: string[];
  agentFactory?: CursorAgentFactory;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function buildCustomTools(
  tools: ToolSpec[],
  ctx: ProviderRunContext,
): Record<string, {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}> {
  const customTools: Record<string, {
    description?: string;
    inputSchema?: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }> = {};

  for (const spec of tools) {
    if (spec.kind === "builtin") continue;
    customTools[spec.name] = {
      description: spec.description ?? `flowgraph tool: ${spec.name}`,
      inputSchema: spec.schema ?? { type: "object", additionalProperties: true },
      execute: async (args) => {
        const gatedArgs = await ctx.checkToolCall(spec.name, args);
        ctx.emit("tool.call", { tool: spec.name, args: gatedArgs });
        let result = await ctx.invokeTool(spec.name, gatedArgs);
        result = await ctx.reportToolResult(spec.name, gatedArgs, result);
        ctx.emit("tool.result", { tool: spec.name, result });
        return result;
      },
    };
  }

  return customTools;
}

async function defaultAgentFactory(options: Record<string, unknown>): Promise<CursorAgentHandle> {
  const { Agent } = await import("@cursor/sdk");
  const agent = await Agent.create(options as Parameters<typeof Agent.create>[0]);
  return {
    send: (prompt, sendOpts) => agent.send(prompt, sendOpts as never),
    [Symbol.asyncDispose]: async () => {
      await agent[Symbol.asyncDispose]();
    },
  };
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

export function createCursorProvider(options: CursorProviderOptions = {}): ProviderAdapter {
  const name = options.name ?? "cursor";
  const agentFactory = options.agentFactory ?? defaultAgentFactory;

  return {
    name,
    capabilities: {
      toolCalling: true,
      structuredOutput: false,
      streaming: true,
      mcp: true,
      ...(options.models ? { models: options.models } : {}),
    },

    validate(config: unknown) {
      const diags: Array<{ severity: "error" | "warning"; message: string }> = [];
      const cfg = config as {
        tools?: Array<Record<string, unknown>>;
        permission?: string;
        hooks?: Array<{ on?: string }>;
      } | undefined;
      const tools = cfg?.tools ?? [];
      const hasBuiltin = tools.some((t) => "builtin" in t);
      const permissionAsk = cfg?.permission === "ask";
      const hasBeforeToolHook = (cfg?.hooks ?? []).some((h) => h.on === "agent:beforeToolCall");

      if (hasBuiltin && (permissionAsk || hasBeforeToolHook)) {
        diags.push({
          severity: "warning",
          message:
            "Cursor provider cannot gate native builtin tools per-call (no canUseTool callback). " +
            "Use function tools (@veloxdevworks/flowgraph-tools-fs) or switch to provider: claude for per-call HITL on Read/Edit/Bash.",
        });
      }

      const apiKeyEnv = (config as { apiKeyEnv?: string } | undefined)?.apiKeyEnv ?? "CURSOR_API_KEY";
      if (!process.env[apiKeyEnv]?.trim()) {
        diags.push({
          severity: "warning",
          message: `Missing ${apiKeyEnv}. Set it before running Cursor provider nodes.`,
        });
      }
      return diags;
    },

    async run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult> {
      const runtime = options.runtime ?? "local";
      const model = req.model ?? options.model ?? "composer-2.5";
      const apiKey = options.apiKey ?? process.env["CURSOR_API_KEY"];

      const agentOptions: Record<string, unknown> = {
        apiKey,
        model: { id: model },
      };

      const customTools = buildCustomTools(req.tools, ctx);
      const sendOptions: Record<string, unknown> = {};

      if (runtime === "cloud") {
        agentOptions["cloud"] = { repos: [] };
      } else {
        agentOptions["local"] = {
          cwd: options.cwd ?? ctx.node.workspace,
          customTools,
          settingSources: [],
          ...(req.permission === "ask" ? { autoReview: true } : {}),
        };
      }

      if (Object.keys(customTools).length > 0 && runtime === "local") {
        sendOptions["local"] = { customTools };
      }

      if (req.schema) {
        agentOptions["instructions"] =
          `Respond with JSON matching this schema:\n${JSON.stringify(req.schema)}`;
      }
      if (req.system) {
        agentOptions["instructions"] = [req.system, agentOptions["instructions"]].filter(Boolean).join("\n\n");
      }

      const steps: AgentStep[] = [];
      let finalText = "";
      let stopReason: AgentResult["stopReason"] = "done";

      await using agent = await agentFactory(agentOptions);
      const run = await agent.send(req.prompt, Object.keys(sendOptions).length ? sendOptions : undefined);

      for await (const event of run.stream()) {
        if (!isRecord(event)) continue;
        const type = event["type"];
        if (type === "assistant") {
          ctx.emit("step", event);
          const message = event["message"];
          if (isRecord(message) && Array.isArray(message["content"])) {
            for (const block of message["content"]) {
              if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
                finalText += block["text"];
                ctx.emit("token", { text: block["text"] });
              }
              if (isRecord(block) && block["type"] === "tool_call") {
                const toolName = typeof block["name"] === "string" ? block["name"] : "tool";
                steps.push({ type: "tool_call", tool: toolName, args: block["input"] });
                ctx.emit("tool.call", { tool: toolName, args: block["input"] });
              }
            }
          }
        } else if (type === "tool_result") {
          const toolName = typeof event["name"] === "string" ? event["name"] : "tool";
          steps.push({ type: "tool_result", tool: toolName, result: event["result"] });
          ctx.emit("tool.result", { tool: toolName, result: event["result"] });
        }
      }

      const result = await run.wait();
      if (result.status === "error") {
        stopReason = "error";
        throw new Error(`Cursor agent run failed (${result.id ?? "unknown"})`);
      }
      if (result.result) finalText = result.result;

      const usage: TokenUsage = {
        inputTokens: Math.ceil(req.prompt.length / 4),
        outputTokens: Math.ceil(finalText.length / 4),
        totalTokens: Math.ceil((req.prompt.length + finalText.length) / 4),
      };
      ctx.emit("usage", usage);

      let output: unknown;
      if (req.schema) {
        output = tryParseJson(finalText) ?? { text: finalText };
      } else {
        output = { text: finalText };
      }

      return { output, steps, usage, stopReason };
    },
  };
}
