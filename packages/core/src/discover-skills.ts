import type { GraphSpec, NodeSpec } from "@flowgraph/spec";

/**
 * Collect skill `uses` references from skill nodes, nested map inners,
 * subgraph embeddings, and agent `tools: [{ skill }]`.
 */
export function discoverSkillUses(spec: GraphSpec): string[] {
  const uses = new Set<string>();
  walkNodes(spec, (node) => {
    if (node.type === "skill") {
      const ref = (node as { uses?: string }).uses;
      if (typeof ref === "string" && ref.length > 0) uses.add(ref);
    }
    collectAgentSkillTools(node, uses);
  });
  return [...uses];
}

function collectAgentSkillTools(node: NodeSpec | Record<string, unknown>, uses: Set<string>): void {
  const type = String((node as { type?: unknown }).type ?? "");
  if (type !== "agent" && type !== "intelligent") return;
  const tools = (node as { with?: { tools?: unknown[] } }).with?.tools;
  if (!Array.isArray(tools)) return;
  for (const t of tools) {
    if (t && typeof t === "object" && "skill" in t && typeof (t as { skill: unknown }).skill === "string") {
      const skill = (t as { skill: string }).skill;
      if (skill.length > 0) uses.add(skill);
    }
  }
}

export function walkNodes(spec: GraphSpec, visit: (node: NodeSpec | Record<string, unknown>, path: string) => void): void {
  const walk = (nodes: Array<NodeSpec | Record<string, unknown>>, path: string) => {
    for (const node of nodes) {
      const id = String((node as { id?: unknown }).id ?? "?");
      visit(node, `${path}.${id}`);
      const type = String((node as { type?: unknown }).type ?? "");
      if (type === "map") {
        const inner = (node as { with?: { node?: Record<string, unknown> } }).with?.node;
        if (inner && typeof inner === "object") walk([inner], `${path}.${id}.map`);
      }
      if (type === "subgraph") {
        const inline = (node as { spec?: GraphSpec }).spec;
        if (inline?.nodes) walk(inline.nodes, `${path}.${id}.subgraph`);
      }
    }
  };
  walk(spec.nodes, "nodes");
}

/** File-based subgraph embeddings (`uses: ./child.graph.yaml`). */
export function discoverSubgraphFileUses(spec: GraphSpec): string[] {
  const uses = new Set<string>();
  walkNodes(spec, (node) => {
    if (String((node as { type?: unknown }).type ?? "") !== "subgraph") return;
    const ref = (node as { uses?: string }).uses;
    if (typeof ref === "string" && ref.length > 0) uses.add(ref);
  });
  return [...uses];
}
