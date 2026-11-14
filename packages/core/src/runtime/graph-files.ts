import type { GraphSpec } from "@flowgraph/spec";

const sources = new WeakMap<GraphSpec, string>();
export function setGraphFile(spec: GraphSpec, file: string): void {
  sources.set(spec, file);
}
export function graphFile(spec: GraphSpec): string | undefined {
  return sources.get(spec);
}

/** File aliases are declarations, so preflight can resolve them without executing imports. */
export function subgraphAliases(spec: GraphSpec): Record<string, string> {
  const aliases = Object.create(null) as Record<string, string>;
  const configured = (spec.config as { subgraphs?: Record<string, string> } | undefined)?.subgraphs;
  Object.assign(aliases, configured);
  for (const imp of spec.imports ?? []) {
    if ("subgraph" in imp) aliases[imp.as ?? imp.subgraph] = imp.subgraph;
  }
  return aliases;
}
