import type { GraphSpec } from "@flowgraph/spec";
import { walkNodes } from "./discover-skills.js";

/**
 * Collect `with.agent` references from agent nodes, including nested map/subgraph.
 */
export function discoverAgentUses(spec: GraphSpec): string[] {
  const uses = new Set<string>();
  walkNodes(spec, (node) => {
    const type = String((node as { type?: unknown }).type ?? "");
    if (type !== "agent" && type !== "intelligent") return;
    const withBlock = (node as { with?: { agent?: unknown } }).with;
    const ref = withBlock?.agent;
    if (typeof ref === "string" && ref.length > 0) uses.add(ref);
  });
  return [...uses];
}
