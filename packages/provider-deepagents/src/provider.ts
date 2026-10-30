/**
 * Deep Agents hub for flowgraph `agent` nodes.
 *
 * Uses the graph's LangChain ChatModel / API key. Tool execution always goes
 * through `ctx.invokeTool` (hooks, permission, workspace). Deep Agents' own
 * approval UI and unrooted filesystem are not used.
 */

import {
  createLangChainProvider,
  type AgentRequest,
  type AgentResult,
  type ChatModelLike,
  type ProviderAdapter,
  type ProviderRunContext,
} from "@flowgraph/core";

export interface DeepAgentsProviderOptions {
  name?: string;
  model: ChatModelLike;
  /** Extra createDeepAgent options (planning, etc.). */
  agentOptions?: Record<string, unknown>;
}

function isGraphInterrupt(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  return name === "GraphInterrupt" || name === "NodeInterrupt" || "lg_interrupt" in err;
}

async function tryCreateDeepAgent(
  model: ChatModelLike,
  req: AgentRequest,
  ctx: ProviderRunContext,
  extra: Record<string, unknown>,
): Promise<AgentResult | undefined> {
  let createDeepAgent: ((opts: Record<string, unknown>) => { invoke: (input: unknown) => Promise<unknown> }) | undefined;
  try {
    const mod = (await import("deepagents")) as {
      createDeepAgent?: (opts: Record<string, unknown>) => { invoke: (input: unknown) => Promise<unknown> };
    };
    createDeepAgent = mod.createDeepAgent;
  } catch {
    return undefined;
  }
  if (typeof createDeepAgent !== "function") return undefined;

  const tools = req.tools.map((spec) => ({
    name: spec.name,
    description: spec.description ?? spec.name,
    schema: spec.schema ?? { type: "object", additionalProperties: true },
    func: async (args: unknown) => ctx.invokeTool(spec.name, args),
  }));

  const agent = createDeepAgent({
    model,
    tools,
    systemPrompt: req.system,
    ...extra,
  });

  const result = await agent.invoke({
    messages: [{ role: "user", content: req.prompt }],
  });
  const rec = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const messages = rec["messages"];
  let text = "";
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1] as { content?: unknown };
    text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  } else if (typeof rec["output"] === "string") {
    text = rec["output"];
  } else {
    text = JSON.stringify(result ?? "");
  }
  return { output: req.schema ? result : { text }, steps: [], stopReason: "done" };
}

export function createDeepAgentsProvider(options: DeepAgentsProviderOptions): ProviderAdapter {
  const name = options.name ?? "deepagents";
  const fallback = createLangChainProvider(options.model, { name });

  return {
    name,
    capabilities: {
      ...fallback.capabilities,
      builtinTools: ["Read", "Edit", "Write", "Bash", "Glob"],
    },
    ...(fallback.validate ? { validate: fallback.validate.bind(fallback) } : {}),
    async run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult> {
      const cached = ctx.replay?.get("provider:result");
      if (cached && typeof cached === "object" && cached !== null && "output" in cached) {
        return cached as AgentResult;
      }
      try {
        const da = await tryCreateDeepAgent(options.model, req, ctx, options.agentOptions ?? {});
        if (da) {
          ctx.replay?.set("provider:result", da);
          return da;
        }
      } catch (err) {
        if (isGraphInterrupt(err)) throw err;
        ctx.node.logger.warn(
          `deepagents hub failed (${err instanceof Error ? err.message : String(err)}); falling back to LangChain loop.`,
        );
      }
      return fallback.run(req, ctx);
    },
  };
}
