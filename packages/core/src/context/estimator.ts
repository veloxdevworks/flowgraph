/**
 * Token estimators for context budgets. The default ("bytes") matches memory
 * recall: UTF-8 bytes / 4, rounded up. Hosts can register a real tokenizer.
 */
import type { ContextMessage } from "./types.js";

export type TokenEstimator = (text: string) => number;

/** Fixed per-message overhead (role and framing) added by messageTokens. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export const bytesEstimator: TokenEstimator = (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

const estimators = new Map<string, TokenEstimator>([["bytes", bytesEstimator]]);

/** Register (or replace) a named estimator, e.g. a tiktoken-backed counter. */
export function registerTokenEstimator(name: string, fn: TokenEstimator): void {
  if (!name) throw new Error("registerTokenEstimator: name is required");
  estimators.set(name, fn);
}

export function hasTokenEstimator(name: string): boolean {
  return estimators.has(name);
}

export function getTokenEstimator(name: string | undefined): TokenEstimator {
  const fn = estimators.get(name ?? "bytes");
  if (!fn) {
    throw new Error(
      `context estimator "${String(name)}" is not registered; call registerTokenEstimator("${String(name)}", fn) before compiling (registered: ${[...estimators.keys()].join(", ")})`,
    );
  }
  return fn;
}

/** Tokens for one message: content, tool calls, and a fixed overhead. */
export function messageTokens(m: ContextMessage, est: TokenEstimator): number {
  let t = MESSAGE_OVERHEAD_TOKENS + est(m.content);
  if (m.toolCalls && m.toolCalls.length > 0) t += est(JSON.stringify(m.toolCalls));
  return t;
}

/**
 * Cut `text` so est(result) <= maxTokens, appending a marker. Deterministic;
 * binary search on the code-point length so any monotone estimator works.
 */
export function truncateToTokens(text: string, maxTokens: number, est: TokenEstimator, marker?: (total: number) => string): string {
  const total = est(text);
  if (total <= maxTokens) return text;
  const tail = marker ? marker(total) : `\n…[truncated: ${total} tokens cut to ${maxTokens}]`;
  const budget = Math.max(0, maxTokens - est(tail));
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (est(chars.slice(0, mid).join("")) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("") + tail;
}
