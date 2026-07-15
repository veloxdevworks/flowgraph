import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

/**
 * Collect `with.agent` references from top-level agent nodes in a graph spec.
 * Nested refs inside map/subgraph are not scanned (v1 scope).
 */
export function discoverAgentUses(spec: GraphSpec): string[] {
  const uses = new Set<string>();
  for (const node of spec.nodes) {
    if (node.type !== "agent" && node.type !== "intelligent") continue;
    const withBlock = (node as { with?: { agent?: unknown } }).with;
    const ref = withBlock?.agent;
    if (typeof ref === "string" && ref.length > 0) uses.add(ref);
  }
  return [...uses];
}
