/**
 * Built-in node type: `agent`
 *
 * An LLM-driven agent (hub) that exposes skills/nodes/functions as tools
 * (spokes). Delegates the agent loop to a pluggable provider.
 */

import { z } from "zod";
import { AgentWithSchema } from "@flowgraph/spec";
import { renderDeep, stringifyRendered } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { providerFor, providerNamesFor } from "../providers/registry.js";
import { normalizeTools, mergeTools, type ToolRef, type ToolWiring } from "../providers/tools.js";
import { expandMcpTools, requireMcpHub } from "../mcp/expand.js";
import type { AgentRequest, ProviderRunContext } from "../providers/types.js";
import { checkToolCall, reportToolResult } from "../providers/governance.js";
import { loadResolvedAgent } from "./agent-runner.js";
import { assertAgentRefAllowed, nodePolicyOf } from "../node-policy.js";
import { applyOutput } from "./output.js";
import { isGraphInterrupt, ReplayStore, replayNodeKey, runScopeOf } from "../providers/replay-cache.js";
import { ISSUES_CHANNEL } from "../runtime/state-annotation.js";
import { ISSUE_CODE, type RunIssue } from "../runtime/run-issues.js";
import type { ToolExecutor, NormalizedTools } from "../providers/tools.js";
import type { AgentMemoryConfig } from "../memory/recall.js";
import { appendRecallSection, recallForAgent, rememberTool } from "./agent-memory.js";

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
          (config.hub === "deepagents" ? "deepagents" : undefined) ??
          nodeProvider ?? ctx.config.defaults?.provider ?? defaultProviderName(ctx);
        if (!providerName) {
          throw new Error(
            `agent node "${String(nodeSpec["id"])}": no provider specified and none registered. ` +
              `Set node.provider, config.defaults.provider, or register a provider.`,
          );
        }
        const provider = providerFor(ctx, providerName);
        if (!provider) {
          throw new Error(
            `agent node "${String(nodeSpec["id"])}": provider "${providerName}" is not registered. ` +
              `Available: ${providerNamesFor(ctx).join(", ") || "(none)"}.`,
          );
        }

        const nodeInput =
          (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
        const scope = { state, input: nodeInput, config: ctx.config, run: ctx.meta };

        let agentBody: string | undefined;
        if (config.agent) {
          assertAgentRefAllowed(nodePolicyOf(ctx), `agent node "${String(nodeSpec["id"])}"`);
          try {
            agentBody = (await loadResolvedAgent(config.agent, ctx)).body;
          } catch (err) {
            throw new Error(`agent node "${String(nodeSpec["id"])}": ${String(err)}`);
          }
        }

        // Recall memory (never written to state). Templates see it as {{ memory.<id> }}.
        const memoryConfig = config.memory as AgentMemoryConfig | undefined;
        const recall = await recallForAgent(ctx, memoryConfig, scope, [config.prompt, config.system, agentBody]);
        const tplScope = recall ? { ...scope, memory: recall.vars } : scope;

        const prompt = stringifyRendered(renderDeep(config.prompt, tplScope));

        let system: string | undefined;
        if (agentBody !== undefined) {
          const agentSystem = stringifyRendered(renderDeep(agentBody, tplScope));
          const extra = config.system ? stringifyRendered(renderDeep(config.system, tplScope)) : undefined;
          system = extra ? `${agentSystem}\n\n${extra}` : agentSystem;
        } else if (config.system) {
          system = stringifyRendered(renderDeep(config.system, tplScope));
        }
        system = prependKnownIssues(system, state);
        system = appendRecallSection(system, recall);

        const { normalized, mcpRefs } = normalizeTools(config.tools as ToolRef[] | undefined, wiring);
        let { specs, executors } = mergeTools(normalized, reportIssueTool());
        const remember = rememberTool(ctx, memoryConfig, scope);
        if (remember) ({ specs, executors } = mergeTools({ specs, executors }, remember));
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

        // Replay entries belong to this execution of the graph (see RunScope);
        // outside one (a node run directly), nothing is replayed across calls.
        const runScope = runScopeOf((ctx as { _lgConfig?: unknown })._lgConfig);
        const replayStore = runScope?.replay ?? new ReplayStore();
        const cacheKey = replayNodeKey(runScope?.path ?? [], ctx.nodeId);
        let toolSeq = 0;

        const providerCtx: ProviderRunContext = {
          node: ctx,
          signal: ctx.signal,
          emit: (type, data) => ctx.emit(`agent.${type}` as import("../events.js").EventType, data),
          replay: {
            get: (index) => replayStore.get(cacheKey, index),
            set: (index, value) => replayStore.set(cacheKey, index, value),
          },
          checkToolCall: (name, args) => checkToolCall(governance, name, args),
          reportToolResult: (name, args, result) => reportToolResult(governance, name, args, result),
          async invokeTool(name, args) {
            const exec = executors.get(name);
            if (!exec) throw new Error(`agent node: tool "${name}" is not available.`);

            // Always run permission/HITL so LangGraph interrupt indices stay aligned on replay.
            const callArgs = await checkToolCall(governance, name, args);
            const toolIndex = `tool:${toolSeq++}`;
            const cached = replayStore.get(cacheKey, toolIndex);
            if (cached !== undefined) return cached;

            ctx.emit("agent.tool.call", { tool: name, args: callArgs });
            let result = await exec(callArgs, ctx, state);
            ctx.emit("agent.tool.result", { tool: name, result });

            result = await reportToolResult(governance, name, callArgs, result);
            replayStore.set(cacheKey, toolIndex, result);
            return result;
          },
        };

        ctx.emit("agent.step", { provider: providerName, model: nodeModel, tools: specs.map((t) => t.name) });

        try {
          const result = await provider.run(req, providerCtx);

          if (result.stopReason === "maxSteps") {
            const maxSteps = req.maxSteps ?? 10;
            ctx.emit("custom.agent.maxSteps", { maxSteps, nodeId: ctx.nodeId });
            ctx.logger.warn(
              `agent node "${String(nodeSpec["id"])}" stopped after maxSteps (${maxSteps}) tool-loop iterations.`,
            );
            ctx.issue({
              code: ISSUE_CODE.MAX_STEPS,
              severity: "warning",
              message: `agent stopped after maxSteps (${maxSteps}) tool-loop iterations`,
              impact: "The agent may not have finished its task.",
              remediation: "Raise with.maxSteps or split the work across more nodes.",
              detail: { maxSteps },
            });
          }

          if (result.usage) {
            ctx.emit("agent.usage", result.usage);
            enforceBudget(ctx, result.usage);
          }

          replayStore.clear(cacheKey);

          return {
            update: {
              ...applyOutput(config.output, result.output, {
                nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
                scope,
              }),
            },
          };
        } catch (err) {
          if (!isGraphInterrupt(err)) replayStore.clear(cacheKey);
          throw err;
        }
      },
    };
  },
});

function prependKnownIssues(system: string | undefined, state: Record<string, unknown>): string | undefined {
  const issues = (state[ISSUES_CHANNEL] as RunIssue[] | undefined) ?? [];
  if (issues.length === 0) return system;
  const block = issues
    .map((i) => {
      const loc = i.nodeId ? ` [${i.nodeId}]` : "";
      const impact = i.impact ? ` Impact: ${i.impact}` : "";
      const fix = i.remediation ? ` Remediation: ${i.remediation}` : "";
      return `- [${i.severity}] ${i.code}${loc}: ${i.message}.${impact}${fix}`;
    })
    .join("\n");
  const section =
    `Known issues so far (these may affect result quality; try to remediate if you can, or report remaining gaps with report_issue):\n${block}`;
  return system ? `${system}\n\n${section}` : section;
}

function reportIssueTool(): NormalizedTools {
  const executors = new Map<string, ToolExecutor>();
  executors.set("report_issue", async (args, ctx) => {
    const rec = (args ?? {}) as Record<string, unknown>;
    const message = String(rec["message"] ?? "").trim();
    if (!message) return { ok: false, error: "message is required" };
    const severity = rec["severity"] === "error" ? "error" : "warning";
    const issue = ctx.issue({
      code: ISSUE_CODE.AGENT_REPORTED,
      severity,
      message,
      ...(typeof rec["impact"] === "string" && rec["impact"] ? { impact: rec["impact"] } : {}),
      ...(typeof rec["remediation"] === "string" && rec["remediation"] ? { remediation: rec["remediation"] } : {}),
    });
    return { ok: true, issue };
  });
  return {
    specs: [
      {
        name: "report_issue",
        kind: "function",
        ref: "report_issue",
        description:
          "Record a non-fatal issue that may affect result quality (missing tools, skipped verification, unverifiable claims). Use this when you could not complete a check you believe is important.",
        schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "What went wrong or could not be verified" },
            impact: { type: "string", description: "How this might affect the result" },
            remediation: { type: "string", description: "What would fix it on a later run" },
            severity: { type: "string", enum: ["warning", "error"] },
          },
          required: ["message"],
        },
      },
    ],
    executors,
  };
}

function defaultProviderName(ctx: NodeRunContext): string | undefined {
  const all = providerNamesFor(ctx);
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
    ctx.issue({
      code: ISSUE_CODE.BUDGET_EXCEEDED,
      severity: "warning",
      message: `Budget exceeded (${detail}) — continuing (onExceed: warn)`,
      impact: "Later agent steps may be truncated or lower quality.",
      remediation: "Raise runtime.budget.maxTokens / maxUSD, or set onExceed: fail to stop instead of degrading.",
      detail: { usedTokens: budget.usedTokens, usedUSD: budget.usedUSD },
    });
  }
}
