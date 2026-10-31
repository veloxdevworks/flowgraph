/**
 * Context management types shared by the agent node and providers.
 */
import type { Message } from "../providers/types.js";

/** A provider-neutral message. Tool calls and results carry their ids. */
export type ContextMessage = Message;

export type ContextStrategy = "none" | "last" | "trim" | "summarize";

/** with.context / runtime.context as written in YAML (all optional). */
export interface ContextConfigInput {
  maxTokens?: number | undefined;
  reserveTokens?: number | undefined;
  strategy?: ContextStrategy | undefined;
  lastN?: number | undefined;
  toolResultMaxTokens?: number | undefined;
  issuesMaxTokens?: number | undefined;
  summarize?:
    | {
        mode?: "model" | "extract" | undefined;
        provider?: string | undefined;
        model?: string | undefined;
        maxTokens?: number | undefined;
        instructions?: string | undefined;
      }
    | undefined;
  estimator?: string | undefined;
  onOverflow?: "error" | "warn" | undefined;
  history?: string | undefined;
  record?: "turns" | "all" | undefined;
  compact?: boolean | undefined;
}

/** A resolved policy: every default applied. */
export interface ContextPolicy {
  maxTokens: number;
  reserveTokens: number;
  strategy: ContextStrategy;
  lastN: number;
  toolResultMaxTokens?: number | undefined;
  /** Cap on the known run issues rendered into the system prompt. */
  issuesMaxTokens: number;
  summarize: {
    mode: "model" | "extract";
    provider?: string | undefined;
    model?: string | undefined;
    maxTokens: number;
    instructions?: string | undefined;
  };
  estimator: string;
  onOverflow: "error" | "warn";
  history?: string | undefined;
  record: "turns" | "all";
  compact: boolean;
}

export const CONTEXT_DEFAULT_MAX_TOKENS = 16000;
export const CONTEXT_DEFAULT_LAST_N = 20;
export const CONTEXT_DEFAULT_SUMMARY_TOKENS = 500;
export const CONTEXT_DEFAULT_ISSUES_TOKENS = 1000;

/** Token counts for one fitted model call (the `agent.context` event). */
export interface ContextStats {
  budget: number;
  total: number;
  system: number;
  tools: number;
  reserve: number;
  history: number;
  prompt: number;
  loop: number;
  summary: number;
  keptMessages: number;
  droppedMessages: number;
  summarizedMessages: number;
  /** Other agents' summaries shortened or left out of this call to fit the budget. */
  sharedSummariesCut?: number;
  overBudget: boolean;
}

/** What to send for one model call. */
export interface FittedContext {
  /** System text: the rendered system prompt plus the omitted-messages marker, if any. */
  system?: string | undefined;
  /**
   * History, then the current prompt, then this run's kept tool loop, in order.
   * Summaries go, fenced as data, at the start of the first user message.
   */
  messages: ContextMessage[];
  stats: ContextStats;
}

/**
 * Hook the agent node hands to providers that run their own tool loop.
 * Call `fit` before every model call with the assistant and tool messages
 * this run has produced so far, and send what it returns. Returned loop
 * messages are the same objects that were passed in.
 */
export interface ProviderContextManager {
  fit(loop: ContextMessage[]): Promise<FittedContext>;
  /** Apply the per-tool-result cap to a serialized tool result. */
  capToolResult(content: string): string;
}

/** Thrown when the pinned part of a call cannot fit the budget. Never retried. */
export class ContextOverflowError extends Error {
  readonly code = "CONTEXT_OVERFLOW";
  readonly retryable = false;
  constructor(
    message: string,
    readonly stats: ContextStats,
  ) {
    super(message);
    this.name = "ContextOverflowError";
  }
}
