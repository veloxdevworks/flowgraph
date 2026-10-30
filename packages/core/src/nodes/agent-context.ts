/**
 * Agent-node context wiring (`with.context` / `runtime.context`): read the
 * history channel, fit each model call into the budget, and write the turn,
 * removals and running summary back to the history channel.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { NodeRunContext } from "../context.js";
import {
  ContextWindow,
  extractiveSummarizer,
  type Summarizer,
} from "../context/window.js";
import { getTokenEstimator } from "../context/estimator.js";
import {
  fromStoredMessage,
  historyMessageId,
  removeMessage,
  renderTranscript,
  summaryMessageId,
  toLangChainMessage,
} from "../context/messages.js";
import { summarizeWithProvider } from "../context/summarize.js";
import type { ContextMessage, ContextPolicy, ContextStats, ProviderContextManager } from "../context/types.js";
import { getProvider } from "../providers/registry.js";
import type { AgentRequest, AgentResult, ProviderAdapter, TokenUsage, ToolSpec } from "../providers/types.js";
import { isGraphInterrupt, memoryReplayCache } from "../providers/replay-cache.js";
import { ISSUE_CODE } from "../runtime/run-issues.js";

export const TRANSCRIPT_HEADER = "Conversation so far:";

/** A map worker runs once per item in parallel; it must not write a shared history channel. */
export function isMapWorker(nodeId: string): boolean {
  return /\[\d+\]$/.test(nodeId);
}

interface StoredHistory {
  history: ContextMessage[];
  systemNotes: string[];
  summary?: ContextMessage | undefined;
  lastId: string;
}

function readHistory(state: Record<string, unknown>, policy: ContextPolicy, nodeId: string): StoredHistory {
  const channel = policy.history;
  if (!channel) return { history: [], systemNotes: [], lastId: "" };
  const raw = state[channel];
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new Error(
      `agent node "${nodeId}": with.context.history "${channel}" must be a type: messages channel (found ${typeof raw})`,
    );
  }
  const stored = ((raw as unknown[] | undefined) ?? []).map(fromStoredMessage).filter((m): m is ContextMessage => !!m);
  const sid = summaryMessageId(channel);
  const summary = stored.find((m) => m.role === "system" && m.id === sid);
  const systemNotes = stored.filter((m) => m.role === "system" && m.id !== sid).map((m) => m.content);
  let history = stored.filter((m) => m.role !== "system");
  // With compact: false the summarized messages stay in the channel; skip what the summary covers.
  const covers = summary?.meta?.["coversThroughId"];
  if (typeof covers === "string") {
    const at = history.findIndex((m) => m.id === covers);
    if (at >= 0) history = history.slice(at + 1);
  }
  const lastId = stored.length ? (stored[stored.length - 1]!.id ?? String(stored.length)) : "";
  return { history, systemNotes, summary, lastId };
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && typeof (output as { text?: unknown }).text === "string") {
    return (output as { text: string }).text;
  }
  return JSON.stringify(output ?? null);
}

export interface AgentContextSession {
  policy: ContextPolicy;
  window: ContextWindow;
  manager: ProviderContextManager;
  /** Fit once and shape the request for the provider. */
  prepare(req: AgentRequest, provider: ProviderAdapter): Promise<void>;
  /** The history channel update for a finished run (undefined: nothing to write). */
  historyUpdate(result: AgentResult): Record<string, unknown> | undefined;
}

export function startAgentContext(args: {
  policy: ContextPolicy;
  ctx: NodeRunContext;
  state: Record<string, unknown>;
  nodeLabel: string;
  agentProvider: string;
  agentModel?: string | undefined;
  cacheKey: string;
  system?: string | undefined;
  prompt: string;
  tools: ToolSpec[];
  onUsage(usage: TokenUsage): void;
}): AgentContextSession {
  const { policy, ctx, state, cacheKey } = args;
  const est = getTokenEstimator(policy.estimator);
  const stored = readHistory(state, policy, args.nodeLabel);
  const promptMsg: ContextMessage = { role: "user", content: args.prompt };
  const extractive = extractiveSummarizer(est);

  const summarizer: Summarizer | undefined =
    policy.strategy !== "summarize"
      ? undefined
      : async (r) => {
          const idx = `ctx:summary:${r.index}`;
          const cached = memoryReplayCache.get(cacheKey, idx);
          if (typeof cached === "string") return cached;
          let text: string;
          const s = policy.summarize;
          const providerName = s.provider ?? (s.model ? args.agentProvider : undefined);
          if (!providerName) {
            text = await extractive(r);
          } else {
            try {
              const p = getProvider(providerName);
              if (!p) throw new Error(`summarize.provider "${providerName}" is not registered`);
              const res = await summarizeWithProvider(p, r, {
                node: ctx,
                model: s.model ?? (s.provider ? undefined : args.agentModel),
                instructions: s.instructions,
                estimator: est,
                signal: ctx.signal,
              });
              text = res.text;
              if (res.usage) args.onUsage(res.usage);
            } catch (err) {
              if (isGraphInterrupt(err)) throw err;
              ctx.issue({
                code: ISSUE_CODE.CONTEXT_SUMMARY_FAILED,
                severity: "warning",
                message: `context summary model failed, used a plain extract instead: ${err instanceof Error ? err.message : String(err)}`,
                impact: "The earlier-conversation summary is a list of excerpts rather than a written summary.",
                remediation: "Check with.context.summarize.provider / model, or leave them unset to always use the extract.",
              });
              text = await extractive(r);
            }
          }
          memoryReplayCache.set(cacheKey, idx, text);
          return text;
        };

  const window = new ContextWindow({
    policy,
    system: args.system,
    systemNotes: stored.systemNotes,
    summary: stored.summary?.content,
    history: stored.history,
    prompt: promptMsg,
    toolsTokens: args.tools.length ? est(JSON.stringify(args.tools)) : 0,
    summarizer,
    estimator: est,
  });

  let lastEmitted = "";
  let warned = false;
  const report = (stats: ContextStats) => {
    const key = JSON.stringify(stats);
    if (key !== lastEmitted) {
      lastEmitted = key;
      ctx.emit("agent.context", { nodeId: ctx.nodeId, strategy: policy.strategy, ...stats });
    }
    if (stats.overBudget && !warned) {
      warned = true;
      ctx.issue({
        code: ISSUE_CODE.CONTEXT_OVER_BUDGET,
        severity: "warning",
        message: `agent prompt is ~${stats.total} tokens, over with.context.maxTokens ${stats.budget} (onOverflow: warn)`,
        impact: "The model call may be rejected or truncated by the provider.",
        remediation: "Raise maxTokens, set toolResultMaxTokens, or shorten the system prompt.",
        detail: { ...stats },
      });
    }
  };

  const manager: ProviderContextManager = {
    async fit(loop) {
      const f = await window.fit(loop);
      report(f.stats);
      return f;
    },
    capToolResult: (s) => window.capToolResult(s),
  };

  return {
    policy,
    window,
    manager,
    async prepare(req, provider) {
      const f = await manager.fit([]);
      req.system = f.system;
      const history = f.messages.slice(0, -1);
      if (provider.capabilities.contextMessages) {
        req.messages = history;
      } else if (history.length > 0) {
        req.prompt = `${TRANSCRIPT_HEADER}\n${renderTranscript(history)}\n\n---\n\n${args.prompt}`;
      }
    },
    historyUpdate(result) {
      const channel = policy.history;
      if (!channel) return undefined;
      if (isMapWorker(ctx.nodeId)) {
        ctx.issue({
          code: ISSUE_CODE.CONTEXT_HISTORY_READ_ONLY,
          severity: "warning",
          message: `agent "${ctx.nodeId}" runs inside map; with.context.history "${channel}" was read but not written`,
          impact: "This item's turn is not added to the conversation history.",
          remediation: "Record the conversation from an agent outside the map, or drop with.context.history here.",
        });
        return undefined;
      }
      const out: BaseMessage[] = [];
      if (policy.compact) {
        for (const m of window.droppedHistory()) if (m.id) out.push(removeMessage(m.id));
      }
      if (policy.strategy === "summarize" && window.summaryChanged && window.summary) {
        const dropped = window.droppedHistory();
        const prevCovers = stored.summary?.meta?.["coversThroughId"];
        const coversThroughId = policy.compact ? undefined : (dropped[dropped.length - 1]?.id ?? prevCovers);
        out.push(
          toLangChainMessage({
            role: "system",
            id: summaryMessageId(channel),
            content: window.summary,
            meta: { summary: true, ...(typeof coversThroughId === "string" ? { coversThroughId } : {}) },
          }),
        );
      }
      let turn: ContextMessage[];
      if (policy.record === "all" && result.turn && result.turn.length > 0) {
        const droppedLoop = policy.compact ? window.droppedLoop() : new Set<ContextMessage>();
        turn = [promptMsg, ...result.turn.filter((m) => !droppedLoop.has(m))];
      } else {
        turn = [promptMsg, { role: "assistant", content: outputText(result.output) }];
      }
      turn.forEach((m, i) => {
        const id = m.id ?? historyMessageId(channel, ctx.nodeId, stored.lastId, i, m);
        out.push(toLangChainMessage({ ...m, id }));
      });
      return { [channel]: out };
    },
  };
}
