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
  SUMMARY_ID_PREFIX,
  toLangChainMessage,
} from "../context/messages.js";
import { summarizeWithProvider } from "../context/summarize.js";
import { summaryBlock } from "../context/summary-block.js";
import type { ContextMessage, ContextPolicy, ContextStats, ProviderContextManager } from "../context/types.js";
import { providerFor, providerNamesFor } from "../providers/registry.js";
import { cachedContextArtefact } from "./context-replay.js";
import type { AgentRequest, AgentResult, ProviderAdapter, TokenUsage, ToolSpec } from "../providers/types.js";
import { isGraphInterrupt, type ReplayStore } from "../providers/replay-cache.js";
import { ISSUE_CODE } from "../runtime/run-issues.js";

export const TRANSCRIPT_HEADER = "Conversation so far:";

/** A map worker runs once per item in parallel; it must not write a shared history channel. */
export function isMapWorker(nodeId: string): boolean {
  return /\[\d+\]$/.test(nodeId);
}

/**
 * True when this node runs inside an embedded subgraph. LangGraph nests the
 * checkpoint namespace (`parent:task|child:task`) for subgraph nodes.
 */
export function inSubgraph(ctx: NodeRunContext): boolean {
  const ns = (ctx as { _lgConfig?: { configurable?: Record<string, unknown> } })._lgConfig?.configurable?.["checkpoint_ns"];
  return typeof ns === "string" && ns.includes("|");
}

interface StoredHistory {
  history: ContextMessage[];
  systemNotes: string[];
  /** This agent's own running summary. */
  summary?: ContextMessage | undefined;
  /** Summaries other agents keep in the same channel. */
  shared: Array<{ node: string; text: string }>;
  lastId: string;
}

function isSummaryMessage(m: ContextMessage): boolean {
  return m.meta?.["summary"] === true && (m.id ?? "").startsWith(SUMMARY_ID_PREFIX);
}

const isString = (v: unknown): v is string => typeof v === "string";

function summaryText(m: ContextMessage): string {
  const t = m.meta?.["text"];
  return typeof t === "string" ? t : m.content;
}

function readHistory(state: Record<string, unknown>, policy: ContextPolicy, nodeLabel: string, nodeId: string): StoredHistory {
  const channel = policy.history;
  if (!channel) return { history: [], systemNotes: [], shared: [], lastId: "" };
  const raw = state[channel];
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new Error(
      `agent node "${nodeLabel}": with.context.history "${channel}" must be a type: messages channel (found ${typeof raw})`,
    );
  }
  const stored = ((raw as unknown[] | undefined) ?? []).map(fromStoredMessage).filter((m): m is ContextMessage => !!m);
  const sid = summaryMessageId(channel, nodeId);
  const summaries = stored.filter(isSummaryMessage);
  const summary = summaries.find((m) => m.id === sid);
  const shared = summaries
    .filter((m) => m !== summary)
    .map((m) => ({ node: typeof m.meta?.["node"] === "string" ? (m.meta["node"] as string) : (m.id ?? ""), text: summaryText(m) }));
  const systemNotes = stored.filter((m) => m.role === "system" && !isSummaryMessage(m)).map((m) => m.content);
  let history = stored.filter((m) => m.role !== "system" && !isSummaryMessage(m));
  // With compact: false the summarized messages stay in the channel; skip what the summary covers.
  const covers = summary?.meta?.["coversThroughId"];
  if (typeof covers === "string") {
    const at = history.findIndex((m) => m.id === covers);
    if (at >= 0) history = history.slice(at + 1);
  }
  const lastId = stored.length ? (stored[stored.length - 1]!.id ?? String(stored.length)) : "";
  return { history, systemNotes, summary, shared, lastId };
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
  /** Replay entries of this execution (see RunScope); summaries are cached here. */
  replayStore: ReplayStore;
  /** Another agent in this graph uses the same history channel. */
  sharedHistory?: boolean;
  system?: string | undefined;
  prompt: string;
  tools: ToolSpec[];
  onUsage(usage: TokenUsage): void;
}): AgentContextSession {
  const { policy, ctx, state, cacheKey, replayStore } = args;
  const est = getTokenEstimator(policy.estimator);
  const stored = readHistory(state, policy, args.nodeLabel, ctx.nodeId);
  const promptMsg: ContextMessage = { role: "user", content: args.prompt };
  const extractive = extractiveSummarizer(est);

  // The summary provider is looked up before the first call, like the
  // agent's own: one the graph cannot use fails the node instead of quietly
  // degrading every summary to an extract.
  const summaryProviderName =
    policy.strategy === "summarize" && policy.summarize.mode !== "extract" ? (policy.summarize.provider ?? args.agentProvider) : undefined;
  const summaryProvider = summaryProviderName ? providerFor(ctx, summaryProviderName) : undefined;
  if (summaryProviderName && !summaryProvider) {
    throw new Error(
      `agent node "${args.nodeLabel}": with.context.summarize.provider "${summaryProviderName}" is not registered for this graph. ` +
        `Available: ${providerNamesFor(ctx).join(", ") || "(none)"}.`,
    );
  }

  const summarizer: Summarizer | undefined =
    policy.strategy !== "summarize"
      ? undefined
      : async (r) => {
          const s = policy.summarize;
          // Default: the agent's own provider and model; extract only when asked for.
          const providerName = s.mode === "extract" ? undefined : (s.provider ?? args.agentProvider);
          const model = s.model ?? (s.provider ? undefined : args.agentModel);
          // Everything the summary is made from: a resume whose fit differs
          // (budget, estimator, summary settings, prompt, tools or history)
          // folds other messages and must not reuse this text.
          const inputs = {
            previous: r.previous ?? null,
            messages: r.messages,
            maxTokens: r.maxTokens,
            estimator: policy.estimator ?? "bytes",
            mode: s.mode ?? null,
            provider: providerName ?? null,
            model: model ?? null,
            instructions: s.instructions ?? null,
          };
          return cachedContextArtefact(replayStore, cacheKey, "summary", r.index, inputs, isString, async () => {
            if (!providerName) return extractive(r);
            const p = summaryProvider!;
            try {
              const res = await summarizeWithProvider(p, r, {
                node: ctx,
                model,
                instructions: s.instructions,
                estimator: est,
                signal: ctx.signal,
              });
              if (res.usage) args.onUsage(res.usage);
              return res.text;
            } catch (err) {
              if (isGraphInterrupt(err)) throw err;
              ctx.issue({
                code: ISSUE_CODE.CONTEXT_SUMMARY_FAILED,
                severity: "warning",
                message: `context summary model failed, used a plain extract instead: ${err instanceof Error ? err.message : String(err)}`,
                impact: "The earlier-conversation summary is a list of excerpts rather than a written summary.",
                remediation: "Check with.context.summarize.provider / model, or set summarize.mode: extract to skip the model.",
              });
              return extractive(r);
            }
          });
        };

  const window = new ContextWindow({
    policy,
    system: args.system,
    systemNotes: stored.systemNotes,
    summary: stored.summary ? summaryText(stored.summary) : undefined,
    sharedSummaries: stored.shared,
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
      // The last message is the prompt (it carries the summary block when no history is kept).
      const history = f.messages.slice(0, -1);
      const prompt = f.messages[f.messages.length - 1]!.content;
      if (provider.capabilities.contextMessages) {
        req.messages = history;
        req.prompt = prompt;
      } else if (history.length > 0) {
        req.prompt = `${TRANSCRIPT_HEADER}\n${renderTranscript(history)}\n\n---\n\n${prompt}`;
      } else {
        req.prompt = prompt;
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
      // Inside a subgraph the channel belongs to the parent: append the turn
      // only, so compaction (removals and the summary message) stays local
      // to the calls this agent makes and never reaches the parent.
      const nested = inSubgraph(ctx);
      const compact = policy.compact && !nested;
      const out: BaseMessage[] = [];
      // A message is removed only when this agent's own summary, written in
      // the same update, covers it (summarize), or when no other agent in
      // the graph uses the channel (trim / last). Each agent keeps its own
      // summary id, so agents running side by side never undo each other.
      let removals: ContextMessage[] = [];
      if (compact) {
        if (policy.strategy === "summarize") removals = window.summarizedHistory();
        else if (!args.sharedHistory) removals = window.droppedHistory();
      }
      const writeSummary =
        !nested && policy.strategy === "summarize" && !!window.summary && (window.summaryChanged || removals.length > 0);
      for (const m of removals) if (m.id) out.push(removeMessage(m.id));
      if (writeSummary) {
        const folded = window.summarizedHistory();
        const prevCovers = stored.summary?.meta?.["coversThroughId"];
        const coversThroughId = policy.compact ? undefined : (folded[folded.length - 1]?.id ?? prevCovers);
        out.push(
          // Stored as a fenced user-role message, so whatever reads the
          // channel sees quoted data rather than a system instruction.
          toLangChainMessage({
            role: "user",
            id: summaryMessageId(channel, ctx.nodeId),
            content: summaryBlock(window.summary!)!,
            meta: {
              summary: true,
              node: ctx.nodeId,
              text: window.summary!,
              ...(typeof coversThroughId === "string" ? { coversThroughId } : {}),
            },
          }),
        );
      }
      let turn: ContextMessage[];
      if (policy.record === "all" && result.turn && result.turn.length > 0) {
        const droppedLoop = compact && (policy.strategy === "summarize" || !args.sharedHistory) ? window.droppedLoop() : new Set<ContextMessage>();
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
