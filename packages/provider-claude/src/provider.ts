/**
 * Claude Agent SDK provider adapter for flowgraph.
 */

import { z } from "zod";
import type {
  ProviderAdapter,
  AgentRequest,
  AgentResult,
  ProviderRunContext,
  AgentStep,
  TokenUsage,
  ToolSpec,
} from "@veloxdevworks/flowgraph-core";

export const CLAUDE_BUILTIN_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Skill",
] as const;

export type ClaudeBuiltinTool = (typeof CLAUDE_BUILTIN_TOOLS)[number];

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface ClaudeQueryRequest {
  prompt: string;
  options: Record<string, unknown>;
}

export type ClaudeQueryFn = (req: ClaudeQueryRequest) => AsyncIterable<unknown>;

export interface ClaudeSdkDeps {
  query: ClaudeQueryFn;
  createSdkMcpServer: (opts: {
    name: string;
    version?: string;
    tools?: unknown[];
  }) => unknown;
  tool: (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
  ) => unknown;
}

export interface ClaudeProviderOptions {
  name?: string;
  model?: string;
  cwd?: string;
  permissionMode?: ClaudePermissionMode;
  apiKey?: string;
  models?: string[];
  deps?: ClaudeSdkDeps;
}

function jsonSchemaToZod(schema?: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const props = (schema?.["properties"] as Record<string, { type?: string }> | undefined) ?? {};
  const required = new Set((schema?.["required"] as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(props)) {
    let field: z.ZodTypeAny;
    switch (def.type) {
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.unknown());
        break;
      case "object":
        field = z.record(z.unknown());
        break;
      default:
        field = z.string();
    }
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  if (Object.keys(shape).length === 0) {
    return { input: z.record(z.unknown()).optional() };
  }
  return shape;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractResultMessage(msg: unknown): {
  text?: string;
  structured?: unknown;
  usage?: TokenUsage;
  stopReason?: AgentResult["stopReason"];
  error?: string;
} | undefined {
  if (!isRecord(msg) || msg["type"] !== "result") return undefined;
  const subtype = msg["subtype"];
  if (subtype === "success") {
    const usageRaw = msg["usage"] as Record<string, number> | undefined;
    const usage: TokenUsage = {
      inputTokens: usageRaw?.["input_tokens"] ?? 0,
      outputTokens: usageRaw?.["output_tokens"] ?? 0,
      totalTokens: (usageRaw?.["input_tokens"] ?? 0) + (usageRaw?.["output_tokens"] ?? 0),
      ...(typeof msg["total_cost_usd"] === "number" ? { costUSD: msg["total_cost_usd"] } : {}),
    };
    return {
      ...(typeof msg["result"] === "string" ? { text: msg["result"] } : {}),
      structured: msg["structured_output"],
      usage,
      stopReason: "done",
    };
  }
  const errors = Array.isArray(msg["errors"]) ? msg["errors"].map(String).join("; ") : String(subtype);
  return { error: errors, stopReason: "error" };
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

async function loadDefaultDeps(): Promise<ClaudeSdkDeps> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: (req) => sdk.query(req as Parameters<typeof sdk.query>[0]),
    createSdkMcpServer: (opts) => sdk.createSdkMcpServer(opts as never),
    tool: sdk.tool as ClaudeSdkDeps["tool"],
  };
}

function buildInvokableTools(
  tools: ToolSpec[],
  deps: ClaudeSdkDeps,
  ctx: ProviderRunContext,
): { mcpServers: Record<string, unknown>; allowedBuiltin: string[] } {
  const invokable = tools.filter((t) => t.kind === "skill" || t.kind === "node" || t.kind === "function" || t.kind === "mcp");
  const allowedBuiltin = tools.filter((t) => t.kind === "builtin").map((t) => t.name);

  const sdkTools = invokable.map((spec) =>
    deps.tool(
      spec.name,
      spec.description ?? `flowgraph tool: ${spec.name}`,
      jsonSchemaToZod(spec.schema),
      async (args) => {
        const gatedArgs = await ctx.checkToolCall(spec.name, args);
        ctx.emit("tool.call", { tool: spec.name, args: gatedArgs });
        let result = await ctx.invokeTool(spec.name, gatedArgs);
        result = await ctx.reportToolResult(spec.name, gatedArgs, result);
        ctx.emit("tool.result", { tool: spec.name, result });
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text" as const, text }] };
      },
    ),
  );

  const mcpServers: Record<string, unknown> = {};
  if (sdkTools.length > 0) {
    const server = deps.createSdkMcpServer({
      name: "flowgraph-tools",
      version: "1.0.0",
      tools: sdkTools,
    });
    mcpServers["flowgraph-tools"] = server;
  }

  return { mcpServers, allowedBuiltin };
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): ProviderAdapter {
  const name = options.name ?? "claude";
  let depsPromise: Promise<ClaudeSdkDeps> | undefined;

  const getDeps = () => {
    depsPromise ??= options.deps ? Promise.resolve(options.deps) : loadDefaultDeps();
    return depsPromise;
  };

  return {
    name,
    capabilities: {
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      builtinTools: [...CLAUDE_BUILTIN_TOOLS],
      mcp: true,
      ...(options.models ? { models: options.models } : {}),
    },

    validate(config: unknown) {
      const diags: Array<{ severity: "error" | "warning"; message: string }> = [];
      const tools = (config as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? [];
      const builtinSet = new Set<string>(CLAUDE_BUILTIN_TOOLS);
      for (const t of tools) {
        if ("builtin" in t && Array.isArray(t.builtin)) {
          for (const b of t.builtin) {
            if (typeof b === "string" && !builtinSet.has(b)) {
              diags.push({ severity: "warning", message: `Unknown Claude builtin tool "${b}".` });
            }
          }
        }
      }
      const apiKeyEnv = (config as { apiKeyEnv?: string } | undefined)?.apiKeyEnv ?? "ANTHROPIC_API_KEY";
      if (!process.env[apiKeyEnv]?.trim()) {
        diags.push({
          severity: "warning",
          message: `Missing ${apiKeyEnv}. Set it before running Claude provider nodes.`,
        });
      }
      return diags;
    },

    async run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult> {
      const deps = await getDeps();
      const { mcpServers, allowedBuiltin } = buildInvokableTools(req.tools, deps, ctx);

      const invokableNames = req.tools
        .filter((t) => t.kind !== "builtin")
        .map((t) => (t.kind === "mcp" || t.kind === "skill" || t.kind === "node" || t.kind === "function" ? `mcp__flowgraph-tools__${t.name}` : t.name));

      const queryOptions: Record<string, unknown> = {
        systemPrompt: req.system,
        maxTurns: req.maxSteps ?? 10,
        cwd: options.cwd ?? ctx.node.workspace,
        permissionMode: options.permissionMode ?? "default",
        mcpServers,
        allowedTools: [...allowedBuiltin, ...invokableNames],
        abortController: ctx.signal ? { signal: ctx.signal } : undefined,
      };

      if (options.model ?? req.model) {
        queryOptions["model"] = req.model ?? options.model;
      }
      if (options.apiKey) {
        queryOptions["apiKey"] = options.apiKey;
      }
      if (req.schema) {
        queryOptions["outputFormat"] = { type: "json_schema", schema: req.schema };
      }

      if (req.permission !== "deny") {
        queryOptions["canUseTool"] = async (toolName: string, input: Record<string, unknown>) => {
          try {
            const gated = await ctx.checkToolCall(toolName, input);
            return {
              behavior: "allow" as const,
              updatedInput: (gated ?? input) as Record<string, unknown>,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { behavior: "deny" as const, message };
          }
        };
      } else {
        queryOptions["disallowedTools"] = ["*"];
      }

      const steps: AgentStep[] = [];
      let finalText: string | undefined;
      let structured: unknown;
      let usage: TokenUsage | undefined;
      let stopReason: AgentResult["stopReason"] = "done";

      for await (const message of deps.query({ prompt: req.prompt, options: queryOptions })) {
        if (!isRecord(message)) continue;
        const type = message["type"];
        if (type === "assistant") {
          ctx.emit("step", message);
        } else if (type === "stream_event") {
          const event = message["event"];
          if (isRecord(event) && event["type"] === "content_block_delta") {
            const delta = event["delta"];
            if (isRecord(delta) && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
              ctx.emit("token", { text: delta["text"] });
            }
          }
        } else if (type === "user" && isRecord(message["message"])) {
          const content = (message["message"] as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (isRecord(block) && block["type"] === "tool_result") {
                const toolName = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "tool";
                const result = block["content"];
                steps.push({ type: "tool_result", tool: toolName, result });
                ctx.emit("tool.result", { tool: toolName, result });
              }
            }
          }
        }

        const parsed = extractResultMessage(message);
        if (parsed) {
          if (parsed.error) {
            stopReason = "error";
            throw new Error(parsed.error);
          }
          finalText = parsed.text;
          structured = parsed.structured;
          usage = parsed.usage;
          stopReason = parsed.stopReason ?? "done";
        }
      }

      let output: unknown;
      if (structured !== undefined) {
        output = structured;
      } else if (req.schema && finalText) {
        output = tryParseJson(finalText) ?? { text: finalText };
      } else {
        output = { text: finalText ?? "" };
      }

      if (usage) ctx.emit("usage", usage);

      return {
        output,
        steps,
        ...(usage ? { usage } : {}),
        stopReason,
      };
    },
  };
}
