import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

/**
 * Collect skill `uses` references from top-level skill nodes in a graph spec.
 * Nested refs inside map/subgraph/intelligent tools are not scanned (v1 scope).
 */
export function discoverSkillUses(spec: GraphSpec): string[] {
  const uses = new Set<string>();
  for (const node of spec.nodes) {
    if (node.type !== "skill") continue;
    const ref = (node as { uses?: string }).uses;
    if (typeof ref === "string" && ref.length > 0) uses.add(ref);
  }
  return [...uses];
}
