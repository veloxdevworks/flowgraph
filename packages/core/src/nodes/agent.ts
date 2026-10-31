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
import { getProvider, listProviders } from "../providers/registry.js";
import { normalizeTools, mergeTools, type ToolRef, type ToolWiring } from "../providers/tools.js";
import { expandMcpTools, requireMcpHub } from "../mcp/expand.js";
import type { AgentRequest, ProviderRunContext } from "../providers/types.js";
import { checkToolCall, reportToolResult } from "../providers/governance.js";
import { loadResolvedAgent } from "./agent-runner.js";
import { applyOutput } from "./output.js";
import {
  hydrateReplay,
  isGraphInterrupt,
  memoryReplayCache,
  replayCacheKey,
} from "../providers/replay-cache.js";
import { REPLAY_CHANNEL, ISSUES_CHANNEL } from "../runtime/state-annotation.js";
import { ISSUE_CODE, type RunIssue } from "../runtime/run-issues.js";
import type { ToolExecutor, NormalizedTools } from "../providers/tools.js";
import type { AgentMemoryConfig } from "../memory/recall.js";
import { MEMORY_RECALL_DEFAULT_TOKENS } from "../memory/types.js";
import { appendRecallSection, recallForAgent, rememberTool } from "./agent-memory.js";
import { resolveContextPolicy, recallBudget } from "../context/policy.js";
import type { ContextConfigInput, ContextPolicy } from "../context/types.js";
import { capIssueLines } from "../context/issues.js";
import { getTokenEstimator } from "../context/estimator.js";
import { startAgentContext, type AgentContextSession } from "./agent-context.js";

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
    assertHistoryChannelAllowed(String(nodeSpec["id"] ?? "?"), (config.context as { history?: unknown } | undefined)?.history);

    return {
      contract: {},
      capabilities: { streaming: true, interruptible: true, sideEffecting: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const providerName =
          (config.hub === "deepagents" ? "deepagents" : undefined) ??
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

        let agentBody: string | undefined;
        if (config.agent) {
          try {
            agentBody = (await loadResolvedAgent(config.agent, ctx)).body;
          } catch (err) {
            throw new Error(`agent node "${String(nodeSpec["id"])}": ${String(err)}`);
          }
        }

        const contextPolicy = resolveContextPolicy(
          buildCtx.contextDefaults,
          config.context as ContextConfigInput | undefined,
          { outputMaxTokens: config.maxTokens },
        );

        // Recall memory (never written to state). Templates see it as {{ memory.<id> }}.
        // Under a context budget, recall gets at most half of it.
        let memoryConfig = config.memory as AgentMemoryConfig | undefined;
        if (contextPolicy && memoryConfig?.recall?.length) {
          memoryConfig = { ...memoryConfig, maxTokens: recallBudget(contextPolicy, memoryConfig.maxTokens ?? MEMORY_RECALL_DEFAULT_TOKENS) };
        }
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
        system = prependKnownIssues(system, state, contextPolicy);
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

        const cacheKey = replayCacheKey(ctx.meta.threadId ?? ctx.meta.runId, ctx.nodeId);
        const persisted = (state[REPLAY_CHANNEL] as Record<string, unknown> | undefined)?.[cacheKey];
        if (persisted && typeof persisted === "object" && !Array.isArray(persisted)) {
          hydrateReplay(cacheKey, persisted as Record<string, unknown>);
        }
        let toolSeq = 0;

        const providerCtx: ProviderRunContext = {
          node: ctx,
          signal: ctx.signal,
          emit: (type, data) => ctx.emit(`agent.${type}` as import("../events.js").EventType, data),
          replay: {
            get: (index) => memoryReplayCache.get(cacheKey, index),
            set: (index, value) => memoryReplayCache.set(cacheKey, index, value),
          },
          checkToolCall: (name, args) => checkToolCall(governance, name, args),
          reportToolResult: (name, args, result) => reportToolResult(governance, name, args, result),
          async invokeTool(name, args) {
            const exec = executors.get(name);
            if (!exec) throw new Error(`agent node: tool "${name}" is not available.`);

            // Always run permission/HITL so LangGraph interrupt indices stay aligned on replay.
            const callArgs = await checkToolCall(governance, name, args);
            const toolIndex = `tool:${toolSeq++}`;
            const cached = memoryReplayCache.get(cacheKey, toolIndex);
            if (cached !== undefined) return cached;

            ctx.emit("agent.tool.call", { tool: name, args: callArgs });
            let result = await exec(callArgs, ctx, state);
            ctx.emit("agent.tool.result", { tool: name, result });

            result = await reportToolResult(governance, name, callArgs, result);
            memoryReplayCache.set(cacheKey, toolIndex, result);
            return result;
          },
        };

        ctx.emit("agent.step", { provider: providerName, model: nodeModel, tools: specs.map((t) => t.name) });

        try {
          let contextSession: AgentContextSession | undefined;
          if (contextPolicy) {
            contextSession = startAgentContext({
              policy: contextPolicy,
              ctx,
              state,
              nodeLabel: String(nodeSpec["id"] ?? ctx.nodeId),
              agentProvider: providerName,
              agentModel: req.model,
              cacheKey,
              sharedHistory: !!contextPolicy.history && !!buildCtx.sharedHistoryChannels?.has(contextPolicy.history),
              system,
              prompt,
              tools: specs,
              onUsage: (usage) => {
                ctx.emit("agent.usage", { ...usage, purpose: "context.summary" });
                enforceBudget(ctx, usage);
              },
            });
            await contextSession.prepare(req, provider);
            providerCtx.context = contextSession.manager;
          }

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

          memoryReplayCache.clear(cacheKey);

          const historyUpdate = contextSession?.historyUpdate(result);
          return {
            update: {
              ...applyOutput(config.output, result.output, {
                nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
                scope,
              }),
              ...(historyUpdate ?? {}),
              [REPLAY_CHANNEL]: { [cacheKey]: null },
            },
          };
        } catch (err) {
          if (!isGraphInterrupt(err)) memoryReplayCache.clear(cacheKey);
          throw err;
        }
      },
    };
  },
});

function prependKnownIssues(
  system: string | undefined,
  state: Record<string, unknown>,
  contextPolicy?: ContextPolicy,
): string | undefined {
  const issues = (state[ISSUES_CHANNEL] as RunIssue[] | undefined) ?? [];
  if (issues.length === 0) return system;
  let lines = issues.map((i) => {
    const loc = i.nodeId ? ` [${i.nodeId}]` : "";
    const impact = i.impact ? ` Impact: ${i.impact}` : "";
    const fix = i.remediation ? ` Remediation: ${i.remediation}` : "";
    return `- [${i.severity}] ${i.code}${loc}: ${i.message}.${impact}${fix}`;
  });
  // Under a context budget the issues section has its own cap (newest kept).
  if (contextPolicy) lines = capIssueLines(lines, contextPolicy.issuesMaxTokens, getTokenEstimator(contextPolicy.estimator));
  const block = lines.join("\n");
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

/**
 * `__`-prefixed channels belong to the engine (issues, replay, services, ...).
 * An agent's history channel gets removals and summaries written to it, so it
 * may never be one of them, under any node policy.
 */
export function assertHistoryChannelAllowed(nodeId: string, history: unknown): void {
  if (typeof history === "string" && history.startsWith("__")) {
    throw new Error(
      `agent node "${nodeId}": with.context.history "${history}" is a reserved channel (names starting with "__" belong to the engine); use a channel of your own with type: messages`,
    );
  }
}
