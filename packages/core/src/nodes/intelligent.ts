/**
 * Built-in node type: `intelligent`
 *
 * An LLM-driven agent (hub) that exposes skills/nodes/functions as tools
 * (spokes). Delegates the agent loop to a pluggable provider.
 */

import { z } from "zod";
import { IntelligentWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { getProvider, listProviders } from "../providers/registry.js";
import { normalizeTools, mergeTools, type ToolRef, type ToolWiring } from "../providers/tools.js";
import { expandMcpTools, requireMcpHub } from "../mcp/expand.js";
import type { AgentRequest, ProviderRunContext } from "../providers/types.js";
import { checkToolCall, reportToolResult } from "../providers/governance.js";

const configSchema = IntelligentWithSchema;
type Config = z.infer<typeof configSchema>;

export const intelligentNode = defineNode<Config>({
  type: "intelligent",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { streaming: true, interruptible: true, sideEffecting: true },

  build(buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const nodeProvider = nodeSpec["provider"] as string | undefined;
    const nodeModel = nodeSpec["model"] as string | undefined;
    // Shared, possibly-populated-later wiring object (the compiler fills in
    // invokeNode once all sibling nodes are built). Read lazily at call time.
    const wiring: ToolWiring =
      (buildCtx as BuildContext & { toolWiring?: ToolWiring }).toolWiring ?? {};

    return {
      contract: {},
      capabilities: { streaming: true, interruptible: true, sideEffecting: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const providerName =
          nodeProvider ?? ctx.config.defaults?.provider ?? defaultProviderName();
        if (!providerName) {
          throw new Error(
            `intelligent node "${String(nodeSpec["id"])}": no provider specified and none registered. ` +
              `Set node.provider, config.defaults.provider, or register a provider.`,
          );
        }
        const provider = getProvider(providerName);
        if (!provider) {
          throw new Error(
            `intelligent node "${String(nodeSpec["id"])}": provider "${providerName}" is not registered. ` +
              `Available: ${listProviders().join(", ") || "(none)"}.`,
          );
        }

        const nodeInput =
          (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
        const scope = { state, input: nodeInput, config: ctx.config, run: ctx.meta };

        const prompt = String(renderDeep(config.prompt, scope));
        const system = config.system ? String(renderDeep(config.system, scope)) : undefined;

        const { normalized, mcpRefs } = normalizeTools(config.tools as ToolRef[] | undefined, wiring);
        let { specs, executors } = normalized;
        if (mcpRefs.length > 0) {
          const expanded = await expandMcpTools(mcpRefs, requireMcpHub(ctx));
          ({ specs, executors } = mergeTools({ specs, executors }, expanded));
        }

        const req: AgentRequest = {
          prompt,
          system,
          tools: specs,
          schema: config.schema,
          model: nodeModel,
          maxSteps: config.maxSteps,
          maxTokens: config.maxTokens,
          permission: config.permission ?? "auto",
        };

        const governance = {
          node: ctx,
          state,
          permission: req.permission ?? "auto",
        };

        const providerCtx: ProviderRunContext = {
          node: ctx,
          signal: ctx.signal,
          emit: (type, data) => ctx.emit(`intelligent.${type}` as import("../events.js").EventType, data),
          checkToolCall: (name, args) => checkToolCall(governance, name, args),
          reportToolResult: (name, args, result) => reportToolResult(governance, name, args, result),
          async invokeTool(name, args) {
            const exec = executors.get(name);
            if (!exec) throw new Error(`intelligent node: tool "${name}" is not available.`);

            const callArgs = await checkToolCall(governance, name, args);

            ctx.emit("intelligent.tool.call", { tool: name, args: callArgs });
            let result = await exec(callArgs, ctx);
            ctx.emit("intelligent.tool.result", { tool: name, result });

            result = await reportToolResult(governance, name, callArgs, result);
            return result;
          },
        };

        ctx.emit("intelligent.step", { provider: providerName, model: nodeModel, tools: specs.map((t) => t.name) });

        const result = await provider.run(req, providerCtx);

        if (result.usage) {
          ctx.emit("intelligent.usage", result.usage);
          enforceBudget(ctx, result.usage);
        }

        // Apply output mapping
        if (!config.output) return { update: { result: result.output } };
        if ("to" in config.output) {
          return { update: { [config.output.to]: result.output } };
        }
        if ("map" in config.output) {
          const update: Record<string, unknown> = {};
          for (const [channel, expr] of Object.entries(config.output.map)) {
            update[channel] = renderDeep(expr, { result: result.output, output: result.output, ...scope });
          }
          return { update };
        }
        return { update: { result: result.output } };
      },
    };
  },
});

function defaultProviderName(): string | undefined {
  const all = listProviders();
  return all.length === 1 ? all[0] : all.includes("mock") ? "mock" : undefined;
}

function enforceBudget(ctx: NodeRunContext, usage: { totalTokens?: number; costUSD?: number }): void {
  const budget = ctx.budget;
  if (!budget) return;
  budget.usedTokens += usage.totalTokens ?? 0;
  budget.usedUSD += usage.costUSD ?? 0;

  const overTokens = budget.maxTokens !== undefined && budget.usedTokens > budget.maxTokens;
  const overUSD = budget.maxUSD !== undefined && budget.usedUSD > budget.maxUSD;
  if (!overTokens && !overUSD) return;

  const detail = `tokens=${budget.usedTokens}/${budget.maxTokens ?? "∞"}, usd=${budget.usedUSD.toFixed(4)}/${budget.maxUSD ?? "∞"}`;
  ctx.emit("custom.budget.exceeded", { detail, onExceed: budget.onExceed });
  if (budget.onExceed === "fail") {
    throw new Error(`Budget exceeded (${detail}).`);
  }
  if (budget.onExceed === "interrupt") {
    ctx.interrupt({ reason: `Budget exceeded (${detail})`, data: { usedTokens: budget.usedTokens, usedUSD: budget.usedUSD } });
  } else {
    ctx.logger.warn(`Budget exceeded (${detail}) — continuing (onExceed: warn).`);
  }
}
