/**
 * Resolve an agent's context policy from runtime.context and with.context.
 */
import {
  CONTEXT_DEFAULT_LAST_N,
  CONTEXT_DEFAULT_MAX_TOKENS,
  CONTEXT_DEFAULT_SUMMARY_TOKENS,
  type ContextConfigInput,
  type ContextPolicy,
} from "./types.js";

/**
 * Field-by-field merge (the node wins; `summarize` is replaced as a whole).
 * Returns undefined when neither level declares a context block, so agents
 * without one keep their exact prompts.
 */
export function resolveContextPolicy(
  graphDefaults: ContextConfigInput | undefined,
  node: ContextConfigInput | undefined,
  opts: { outputMaxTokens?: number | undefined } = {},
): ContextPolicy | undefined {
  if (!graphDefaults && !node) return undefined;
  const pick = <K extends keyof ContextConfigInput>(k: K): ContextConfigInput[K] =>
    node?.[k] !== undefined ? node[k] : graphDefaults?.[k];
  const summarize = pick("summarize");
  return {
    maxTokens: pick("maxTokens") ?? CONTEXT_DEFAULT_MAX_TOKENS,
    reserveTokens: pick("reserveTokens") ?? opts.outputMaxTokens ?? 0,
    strategy: pick("strategy") ?? "trim",
    lastN: pick("lastN") ?? CONTEXT_DEFAULT_LAST_N,
    toolResultMaxTokens: pick("toolResultMaxTokens"),
    summarize: {
      ...(summarize ?? {}),
      maxTokens: summarize?.maxTokens ?? CONTEXT_DEFAULT_SUMMARY_TOKENS,
    },
    estimator: pick("estimator") ?? "bytes",
    onOverflow: pick("onOverflow") ?? "error",
    history: node?.history,
    record: node?.record ?? "turns",
    compact: node?.compact ?? true,
  };
}

/**
 * Tokens memory recall may use under this policy: half of the budget left
 * after the reply reserve, so history and the prompt keep the other half.
 */
export function recallBudget(policy: ContextPolicy, memoryMaxTokens: number): number {
  const half = Math.floor((policy.maxTokens - policy.reserveTokens) / 2);
  return Math.max(1, Math.min(memoryMaxTokens, half));
}
