import { normalizeRunsOn, type GraphSpec, type NodeSpec } from "@flowgraph/spec";
import { CORE_BUILTIN_NODE_TYPES } from "../nodes/index.js";

export interface RequirementsOptions {
  /** Resolve a `uses:` subgraph reference to its spec. */
  loadChild?: (ref: string) => GraphSpec | undefined;
}

function collectTypes(node: NodeSpec, out: Set<string>, opts: RequirementsOptions, depth = 0): void {
  if (depth > 32) return;
  if (!CORE_BUILTIN_NODE_TYPES.has(node.type)) out.add(node.type);
  const walkGraph = (g: GraphSpec) => g.nodes?.forEach((n) => collectTypes(n, out, opts, depth + 1));
  if (node.spec) walkGraph(node.spec);
  else if (node.type === "subgraph" && node.uses) {
    const child = opts.loadChild?.(node.uses);
    if (child) walkGraph(child);
  }
  const inner = (node.with as { node?: NodeSpec } | undefined)?.node;
  if (node.type === "map" && inner && typeof inner === "object") collectTypes(inner, out, opts, depth + 1);
}

/**
 * Labels a placed node needs: its declared `runsOn.labels` plus `nodeType:<type>` for every
 * non-core node type that will run remotely. No `plugin:` labels are inferred: core keeps no
 * node-type to plugin mapping.
 */
export function effectiveRequirements(node: NodeSpec, opts: RequirementsOptions = {}): string[] {
  const declared = node.runsOn !== undefined ? normalizeRunsOn(node.runsOn).labels : [];
  const types = new Set<string>();
  collectTypes(node, types, opts);
  return [...new Set([...declared, ...[...types].sort().map((t) => `nodeType:${t}`)])];
}
