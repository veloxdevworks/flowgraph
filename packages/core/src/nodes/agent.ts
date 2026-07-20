/**
 * Built-in node type: `agent`
 *
 * An LLM-driven agent (hub) that exposes skills/nodes/functions as tools
 * (spokes). Delegates the agent loop to a pluggable provider.
 */

import { z } from "zod";
import { AgentWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { getProvider, listProviders } from "../providers/registry.js";
import { normalizeTools, mergeTools, type ToolRef, type ToolWiring } from "../providers/tools.js";
import { expandMcpTools, requireMcpHub } from "../mcp/expand.js";
import type { AgentRequest, ProviderRunContext } from "../providers/types.js";
import { checkToolCall, reportToolResult } from "../providers/governance.js";
import { loadResolvedAgent } from "./agent-runner.js";
import { applyOutput } from "./output.js";

const configSchema = AgentWithSchema;
type Config = z.infer<typeof configSchema>;

export const agentNode = defineNode<Config>({
  type: "agent",
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
            `agent node "${String(nodeSpec["id"])}": no provider specified and none registered. ` +
              `Set node.provider, config.defaults.provider, or register a provider.`,
          );
        }
        const provider = getProvider(providerName);
        if (!provider) {
          throw new Error(
            `agent node "${String(nodeSpec["id"])}": provider "${providerName}" is not registered. ` +
              `Available: ${listProviders().join(", ") || "(none)"}.`,
          );
        }

        const nodeInput =
          (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
        const scope = { state, input: nodeInput, config: ctx.config, run: ctx.meta };

        const prompt = String(renderDeep(config.prompt, scope));

        let system: string | undefined;
        if (config.agent) {
          let agentDef;
          try {
            agentDef = await loadResolvedAgent(config.agent, ctx);
          } catch (err) {
            throw new Error(`agent node "${String(nodeSpec["id"])}": ${String(err)}`);
          }
          const agentSystem = String(renderDeep(agentDef.body, scope));
          const extra = config.system ? String(renderDeep(config.system, scope)) : undefined;
          system = extra ? `${agentSystem}\n\n${extra}` : agentSystem;
        } else if (config.system) {
          system = String(renderDeep(config.system, scope));
        }

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
          model: nodeModel ?? ctx.config.defaults?.model,
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
          emit: (type, data) => ctx.emit(`agent.${type}` as import("../events.js").EventType, data),
          checkToolCall: (name, args) => checkToolCall(governance, name, args),
          reportToolResult: (name, args, result) => reportToolResult(governance, name, args, result),
          async invokeTool(name, args) {
            const exec = executors.get(name);
            if (!exec) throw new Error(`agent node: tool "${name}" is not available.`);

            const callArgs = await checkToolCall(governance, name, args);

            ctx.emit("agent.tool.call", { tool: name, args: callArgs });
            let result = await exec(callArgs, ctx);
            ctx.emit("agent.tool.result", { tool: name, result });

            result = await reportToolResult(governance, name, callArgs, result);
            return result;
          },
        };

        ctx.emit("agent.step", { provider: providerName, model: nodeModel, tools: specs.map((t) => t.name) });

        const result = await provider.run(req, providerCtx);

        if (result.usage) {
          ctx.emit("agent.usage", result.usage);
          enforceBudget(ctx, result.usage);
        }

        return {
          update: applyOutput(config.output, result.output, {
            nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
            scope,
          }),
        };
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
