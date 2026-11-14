import type { GraphSpec, NodeSpec } from "@flowgraph/spec";
import { evalGuard } from "@flowgraph/expr";
import { Command } from "@langchain/langgraph";
import type { Hook } from "../hooks/types.js";

export const ROUTING_CHANNEL = "__routing";
const phases = new Set(["node:before", "node:after", "node:error"]);

export function recoveryTargets(spec: GraphSpec, node: NodeSpec, hooks: Hook[] = []): string[] {
  const targets = new Set<string>();
  if (node.on?.error?.startsWith("route:")) targets.add(node.on.error.slice(6));
  const innerPolicy =
    node.type === "map"
      ? (node.with?.node as { on?: { error?: string } } | undefined)?.on?.error
      : undefined;
  if (innerPolicy?.startsWith("route:")) targets.add(innerPolicy.slice(6));
  for (const hook of spec.runtime?.hooks ?? []) {
    if (!phases.has(hook.on) || !hook.do.startsWith("route:")) continue;
    if (hook.where?.nodeId && hook.where.nodeId !== node.id) continue;
    if (hook.where?.nodeType && hook.where.nodeType !== node.type) continue;
    targets.add(hook.do.slice(6));
  }
  // Programmatic hooks choose their target at runtime.
  if (
    hooks.some(
      (h) =>
        phases.has(h.phase) &&
        (!h.where?.nodeId || h.where.nodeId === node.id) &&
        (!h.where?.nodeType || h.where.nodeType === node.type),
    )
  ) {
    for (const n of spec.nodes) targets.add(n.id);
    targets.add("END");
  }
  return [...targets];
}

export function normalTargets(
  spec: GraphSpec,
  id: string,
  state: Record<string, unknown>,
): string[] {
  const targets = new Set<string>();
  for (const edge of spec.edges) {
    if (edge.from !== id) continue;
    if ("to" in edge)
      for (const to of Array.isArray(edge.to) ? edge.to : [edge.to]) targets.add(to);
    else {
      const chosen =
        edge.branch.find((b) => {
          if (b.default || !b.when) return false;
          try {
            return evalGuard(b.when.replace(/^\s*\{\{|\}\}\s*$/g, "").trim(), { state });
          } catch {
            return false;
          }
        }) ?? edge.branch.find((b) => b.default);
      targets.add(chosen?.to ?? "END");
    }
  }
  return [...targets];
}

/** Select destinations after the update's reducers, without additive static edges. */
export function exclusiveRouting<T extends Record<string, unknown>, C>(
  id: string,
  enabled: boolean,
  run: (state: T, config?: C) => Promise<Record<string, unknown>>,
) {
  if (!enabled) return run;
  return async (state: T, config?: C): Promise<Record<string, unknown>> => {
    const result = await run(state, config);
    const command = result instanceof Command ? result : undefined;
    if (
      command?.goto == null &&
      (state[ROUTING_CHANNEL] as Record<string, unknown> | undefined)?.[id] == null
    ) {
      return command ? ((command.update as Record<string, unknown>) ?? {}) : result;
    }
    return {
      ...(command ? ((command.update as Record<string, unknown>) ?? {}) : result),
      [ROUTING_CHANNEL]: { [id]: command?.goto ?? null },
    };
  };
}
