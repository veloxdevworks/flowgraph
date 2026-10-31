/**
 * ContextWindow decides what one agent run sends on each model call.
 *
 * The message sequence is: history units (from the agent's history channel),
 * the current prompt, then this run's tool-loop units. A unit is a single
 * message, or an assistant tool-call message with all its tool results, and
 * is always kept or dropped as a whole. Pinned (never dropped): the system
 * text, the prompt, and the newest tool-loop unit. Droppable units go oldest
 * first; once dropped they stay dropped for the rest of the run, so each call
 * is a pure function of the history and the loop so far (deterministic on
 * replay and resume).
 */
import { getTokenEstimator, messageTokens, truncateToTokens, type TokenEstimator } from "./estimator.js";
import { toUnits } from "./messages.js";
import { summaryBlock } from "./summary-block.js";
import {
  ContextOverflowError,
  type ContextMessage,
  type ContextPolicy,
  type ContextStats,
  type FittedContext,
} from "./types.js";

export interface SummarizeRequest {
  /** Summary so far (from the history channel or earlier in this run). */
  previous?: string | undefined;
  /** Messages newly left out, oldest first. */
  messages: ContextMessage[];
  maxTokens: number;
  /** 0-based count of summaries made in this run (replay index). */
  index: number;
}

export type Summarizer = (req: SummarizeRequest) => Promise<string>;

export interface ContextWindowInit {
  policy: ContextPolicy;
  /** Rendered system prompt (memory recall and run issues included). */
  system?: string | undefined;
  /** Other system messages found in the history channel, kept verbatim. */
  systemNotes?: string[];
  /** This agent's running summary already stored in the history channel. */
  summary?: string | undefined;
  /** Summaries other agents keep in the same history channel (read only, sent as they are). */
  sharedSummaries?: Array<{ node: string; text: string }>;
  /** History (no system messages), oldest first. */
  history?: ContextMessage[];
  prompt: ContextMessage;
  /** Tokens taken by tool schemas. */
  toolsTokens?: number;
  summarizer?: Summarizer | undefined;
  estimator?: TokenEstimator;
}

export function omittedMarker(n: number): string {
  return `[${n} earlier message${n === 1 ? " was" : "s were"} left out to fit the context budget.]`;
}

/** Share of the free budget that summarize keeps after folding (hysteresis, so it does not summarize every call). */
const SUMMARIZE_KEEP_RATIO = 0.75;

export class ContextWindow {
  readonly policy: ContextPolicy;
  private readonly est: TokenEstimator;
  private readonly baseSystem: string[];
  private readonly shared: Array<{ node: string; text: string }>;
  private readonly prompt: ContextMessage;
  private readonly history: ContextMessage[][];
  private readonly invalidHistory: ContextMessage[];
  private readonly toolsTokens: number;
  private readonly summarizer: Summarizer | undefined;
  private readonly tokenCache = new WeakMap<ContextMessage, number>();
  private readonly baseSystemTokens: number;
  private readonly promptTokens: number;

  /** Units dropped so far (history first, then loop). Never decreases. */
  private droppedUnits = 0;
  private droppedMsgs = 0;
  /** Units folded into `summary` this run. */
  private summarizedUnits = 0;
  private summarizedMsgs = 0;
  private summaryText: string | undefined;
  private readonly initialSummary: string | undefined;
  private summaryCalls = 0;
  private lastStats: ContextStats | undefined;
  private lastLoopUnits: ContextMessage[][] = [];

  constructor(init: ContextWindowInit) {
    this.policy = init.policy;
    this.est = init.estimator ?? getTokenEstimator(init.policy.estimator);
    this.baseSystem = [init.system, ...(init.systemNotes ?? [])].filter((s): s is string => !!s && s.length > 0);
    this.shared = (init.sharedSummaries ?? []).filter((x) => x.text.length > 0);
    this.prompt = init.prompt;
    const { units, invalid } = toUnits(init.history ?? []);
    this.history = units;
    this.invalidHistory = invalid;
    this.toolsTokens = init.toolsTokens ?? 0;
    this.summarizer = init.summarizer;
    this.summaryText = init.summary && init.summary.length > 0 ? init.summary : undefined;
    this.initialSummary = this.summaryText;
    this.baseSystemTokens = this.baseSystem.length ? this.est(this.baseSystem.join("\n\n")) : 0;
    this.promptTokens = this.tok(this.prompt);
  }

  /** History messages that were not sent because a tool call and its result were not both present. */
  get skippedHistory(): ContextMessage[] {
    return this.invalidHistory;
  }

  /** History units left out by the latest fit. */
  droppedHistory(): ContextMessage[] {
    return this.history.slice(0, Math.min(this.droppedUnits, this.history.length)).flat();
  }

  /** History messages folded into this run's summary (strategy: summarize). */
  summarizedHistory(): ContextMessage[] {
    return this.history.slice(0, Math.min(this.summarizedUnits, this.history.length)).flat();
  }

  /** Tool-loop messages left out by the latest fit (by identity). */
  droppedLoop(): Set<ContextMessage> {
    const n = Math.max(0, this.droppedUnits - this.history.length);
    return new Set(this.lastLoopUnits.slice(0, n).flat());
  }

  /** History units still sent by the latest fit. */
  keptHistory(): ContextMessage[] {
    return this.history.slice(Math.min(this.droppedUnits, this.history.length)).flat();
  }

  get summary(): string | undefined {
    return this.summaryText;
  }

  get summaryChanged(): boolean {
    return this.summaryText !== this.initialSummary;
  }

  get stats(): ContextStats | undefined {
    return this.lastStats;
  }

  private tok(m: ContextMessage): number {
    let t = this.tokenCache.get(m);
    if (t === undefined) {
      t = messageTokens(m, this.est);
      this.tokenCache.set(m, t);
    }
    return t;
  }

  private unitTokens(u: ContextMessage[]): number {
    let t = 0;
    for (const m of u) t += this.tok(m);
    return t;
  }

  /** The omitted-messages marker added to the system text, if any. */
  private section(droppedMsgs: number, summary: string | undefined): string | undefined {
    const own = this.policy.strategy === "summarize" && summary ? summary : undefined;
    return !own && droppedMsgs > 0 ? omittedMarker(droppedMsgs) : undefined;
  }

  /** The summaries, fenced as data, sent at the start of the first user turn. */
  private block(summary: string | undefined): string | undefined {
    return summaryBlock(this.policy.strategy === "summarize" ? summary : undefined, this.shared);
  }

  private blockTokens(summary: string | undefined): number {
    const b = this.block(summary);
    // the "\n\n" joiner, plus a message's overhead in case it goes in its own turn
    return b ? this.est(`${b}\n\n`) + 4 : 0;
  }

  private systemText(droppedMsgs: number, summary: string | undefined, marker = true): string | undefined {
    const parts = [...this.baseSystem];
    const sec = marker ? this.section(droppedMsgs, summary) : undefined;
    if (sec) parts.push(sec);
    return parts.length ? parts.join("\n\n") : undefined;
  }

  /** Tokens of the marker and the summary block together. */
  private sectionTokens(droppedMsgs: number, summary: string | undefined): number {
    const sec = this.section(droppedMsgs, summary);
    // the "\n\n" joiner plus the marker itself
    const marker = !sec ? 0 : this.baseSystem.length ? this.est(`\n\n${sec}`) : this.est(sec);
    return marker + this.blockTokens(summary);
  }

  /** Fit the history, the prompt, and the loop so far into the budget. */
  async fit(loop: ContextMessage[] = []): Promise<FittedContext> {
    const p = this.policy;
    const { units: loopUnits } = toUnits(loop);
    this.lastLoopUnits = loopUnits;
    const all = [...this.history, ...loopUnits];
    const pinnedTail = loopUnits.length > 0 ? 1 : 0;
    const maxDrop = all.length - pinnedTail;
    const unitTok = all.map((u) => this.unitTokens(u));
    const unitLen = all.map((u) => u.length);

    const fixed = this.baseSystemTokens + this.toolsTokens + p.reserveTokens + this.promptTokens;
    // suffix sums: tokens/messages of units k..end
    const sufTok = new Array<number>(all.length + 1).fill(0);
    const sufLen = new Array<number>(all.length + 1).fill(0);
    for (let k = all.length - 1; k >= 0; k--) {
      sufTok[k] = sufTok[k + 1]! + unitTok[k]!;
      sufLen[k] = sufLen[k + 1]! + unitLen[k]!;
    }
    const totalLen = sufLen[0]!;
    const droppedLenAt = (k: number): number => totalLen - sufLen[k]!;
    const totalAt = (k: number, summary: string | undefined): number =>
      fixed + sufTok[k]! + this.sectionTokens(droppedLenAt(k), summary);

    let k = Math.min(this.droppedUnits, maxDrop);
    if (p.strategy === "last") {
      while (k < maxDrop && sufLen[k]! > p.lastN) k++;
    }
    if (p.strategy === "trim" || p.strategy === "last") {
      while (k < maxDrop && totalAt(k, undefined) > p.maxTokens) k++;
    } else if (p.strategy === "summarize" && totalAt(k, this.summaryText) > p.maxTokens) {
      const free = p.maxTokens - fixed - p.summarize.maxTokens - this.sectionTokens(0, " ");
      const target = Math.floor(Math.max(0, free) * SUMMARIZE_KEEP_RATIO);
      while (k < maxDrop && sufTok[k]! > target) k++;
    }
    if (k < this.droppedUnits) k = this.droppedUnits; // never un-drop
    // Start kept history at a user message: some vendors reject a leading
    // assistant or tool turn, and half a turn reads badly anyway.
    if (k > 0) {
      while (k < this.history.length && k < maxDrop && this.history[k]![0]!.role !== "user") k++;
    }

    if (k > this.droppedUnits) {
      this.droppedUnits = k;
      this.droppedMsgs = droppedLenAt(k);
    }

    if (p.strategy === "summarize" && this.droppedUnits > this.summarizedUnits) {
      const newly = all.slice(this.summarizedUnits, this.droppedUnits).flat();
      const s = this.summarizer ?? extractiveSummarizer(this.est);
      const req: SummarizeRequest = {
        previous: this.summaryText,
        messages: newly,
        maxTokens: p.summarize.maxTokens,
        index: this.summaryCalls++,
      };
      const text = (await s(req)).trim();
      this.summaryText = truncateToTokens(text, p.summarize.maxTokens, this.est, () => "\n…");
      this.summarizedUnits = this.droppedUnits;
      this.summarizedMsgs = this.droppedMsgs;
    }

    const kept = all.slice(this.droppedUnits);
    const keptHistory = this.history.slice(Math.min(this.droppedUnits, this.history.length));
    const keptLoop = kept.slice(keptHistory.length);
    const summary = p.strategy === "summarize" ? this.summaryText : undefined;
    let sectionTok = this.sectionTokens(this.droppedMsgs, summary);
    const historyTok = keptHistory.reduce((a, u) => a + this.unitTokens(u), 0);
    const loopTok = keptLoop.reduce((a, u) => a + this.unitTokens(u), 0);
    let total = fixed + historyTok + loopTok + sectionTok;
    // The omitted-messages marker is a courtesy: leave it out rather than
    // overflow when the call fits without it.
    let marker = true;
    const markerTok = sectionTok - this.blockTokens(summary);
    if (markerTok > 0 && total > p.maxTokens && total - markerTok <= p.maxTokens) {
      marker = false;
      sectionTok -= markerTok;
      total -= markerTok;
    }
    const stats: ContextStats = {
      budget: p.maxTokens,
      total,
      system: this.baseSystemTokens,
      tools: this.toolsTokens,
      reserve: p.reserveTokens,
      history: historyTok,
      prompt: this.promptTokens,
      loop: loopTok,
      summary: sectionTok,
      keptMessages: sufLen[this.droppedUnits]! + 1,
      droppedMessages: this.droppedMsgs,
      summarizedMessages: p.strategy === "summarize" ? this.summarizedMsgs : 0,
      overBudget: total > p.maxTokens,
    };
    this.lastStats = stats;
    if (stats.overBudget && p.onOverflow === "error") {
      throw new ContextOverflowError(
        `CONTEXT_OVERFLOW: context budget exceeded: this call needs ~${total} tokens but with.context.maxTokens is ${p.maxTokens} ` +
          `(system ${stats.system}, tools ${stats.tools}, reserve ${stats.reserve}, prompt ${stats.prompt}, ` +
          `newest tool step ${loopTok}, history ${historyTok}, summary ${sectionTok}). ` +
          `Raise maxTokens, set toolResultMaxTokens, shorten the prompt, or set onOverflow: warn.`,
        stats,
      );
    }
    const messages = [...keptHistory.flat(), this.prompt, ...keptLoop.flat()];
    const block = this.block(summary);
    if (block) {
      const first = messages[0]!;
      if (first.role === "user") {
        const { meta: _meta, ...rest } = first;
        messages[0] = { ...rest, content: `${block}\n\n${first.content}` };
      }
      else messages.unshift({ role: "user", content: block });
    }
    return { system: this.systemText(this.droppedMsgs, summary, marker), messages, stats };
  }

  /** Apply toolResultMaxTokens to one tool result. */
  capToolResult(content: string): string {
    const max = this.policy.toolResultMaxTokens;
    if (max === undefined) return content;
    return capToolResult(content, max, this.est);
  }
}

export function capToolResult(content: string, maxTokens: number, est: TokenEstimator): string {
  return truncateToTokens(content, maxTokens, est, (total) => `\n…[truncated: ${maxTokens} of ${total} tokens kept]`);
}

const SNIPPET_TOKENS = 60;

function oneLine(m: ContextMessage, est: TokenEstimator): string {
  let body: string;
  if (m.role === "assistant" && m.toolCalls?.length) {
    body = `${m.content ? `${m.content} ` : ""}[called ${m.toolCalls.map((c) => c.name).join(", ")}]`;
  } else {
    body = m.content;
  }
  body = body.replace(/\s+/g, " ").trim();
  body = truncateToTokens(body, SNIPPET_TOKENS, est, () => " …");
  const role = m.role === "tool" ? "tool result" : m.role;
  return `- ${role}: ${body}`;
}

/**
 * Deterministic summary without a model: one short line per message, newest
 * lines kept when over budget. Used when no summarize.provider is set and as
 * the fallback when the summarizer model fails.
 */
export function extractiveSummarizer(est: TokenEstimator): Summarizer {
  return async ({ previous, messages, maxTokens }) => {
    const lines = [...(previous ? previous.split("\n") : []), ...messages.map((m) => oneLine(m, est))].filter(
      (l) => l.length > 0,
    );
    const out: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = est(`${lines[i]}\n`);
      if (used + t > maxTokens) break;
      out.unshift(lines[i]!);
      used += t;
    }
    return out.join("\n");
  };
}
