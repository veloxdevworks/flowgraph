/**
 * History channels named by more than one agent in the same graph.
 */

/** Channels that two or more agent nodes in `nodes` (one graph level, map and subgraph bodies excluded) use as with.context.history. */
export function sharedHistoryChannels(nodes: ReadonlyArray<Record<string, unknown>>): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const node of nodes) {
    if (node["type"] !== "agent") continue;
    const ctx = (node["with"] as { context?: { history?: unknown } } | undefined)?.context;
    const ch = ctx?.history;
    if (typeof ch !== "string" || ch.length === 0) continue;
    if (seen.has(ch)) shared.add(ch);
    seen.add(ch);
  }
  return shared;
}
