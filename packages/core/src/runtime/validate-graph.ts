/**
 * Offline graph lint helpers used by validateSpec.
 */

import type { GraphSpec, Diagnostic } from "@veloxdevworks/flowgraph-spec";
import { registry } from "../registry.js";
import { fanInLastWriteDiagnostics } from "./fan-in-warning.js";

function outgoingTargets(spec: GraphSpec, from: string): string[] {
  const targets: string[] = [];
  for (const edge of spec.edges) {
    if (edge.from !== from) continue;
    if ("to" in edge) {
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
      targets.push(...tos);
    }
    if ("branch" in edge) {
      for (const b of edge.branch) targets.push(b.to);
    }
  }
  return targets;
}

function incomingSources(spec: GraphSpec, to: string): string[] {
  const sources: string[] = [];
  for (const edge of spec.edges) {
    if ("to" in edge) {
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
      if (tos.includes(to)) sources.push(edge.from);
    }
    if ("branch" in edge) {
      for (const b of edge.branch) {
        if (b.to === to) sources.push(edge.from);
      }
    }
  }
  return sources;
}

/** Nodes reachable from START by following edges (excluding END). */
export function nodesReachableFromStart(spec: GraphSpec): Set<string> {
  const reachable = new Set<string>();
  const queue = outgoingTargets(spec, "START").filter((t) => t !== "END");

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of outgoingTargets(spec, id)) {
      if (next !== "END" && !reachable.has(next)) queue.push(next);
    }
  }
  return reachable;
}

/** Nodes that can eventually reach END. */
export function nodesThatReachEnd(spec: GraphSpec): Set<string> {
  const canReach = new Set<string>();
  const queue: string[] = [];

  for (const node of spec.nodes) {
    if (outgoingTargets(spec, node.id).includes("END")) {
      queue.push(node.id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (canReach.has(id)) continue;
    canReach.add(id);
    for (const pred of incomingSources(spec, id)) {
      if (pred !== "START" && !canReach.has(pred)) queue.push(pred);
    }
  }
  return canReach;
}

export function reachabilityDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fromStart = nodesReachableFromStart(spec);
  const toEnd = nodesThatReachEnd(spec);

  for (const node of spec.nodes) {
    if (!fromStart.has(node.id)) {
      diagnostics.push({
        severity: "warning",
        code: "UNREACHABLE_FROM_START",
        message: `Node "${node.id}" is not reachable from START`,
        path: `nodes.${node.id}`,
      });
    } else if (!toEnd.has(node.id)) {
      diagnostics.push({
        severity: "warning",
        code: "NO_PATH_TO_END",
        message: `Node "${node.id}" has no path to END`,
        path: `nodes.${node.id}`,
      });
    }
  }

  return diagnostics;
}

export function channelReducerDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const channels = spec.state?.channels ?? {};

  for (const [name, ch] of Object.entries(channels)) {
    const reducer = ch.reducer;
    const path = `state.channels.${name}`;

    if (reducer === "append" || reducer === "concat") {
      if (ch.type !== "array" && ch.type !== "any") {
        diagnostics.push({
          severity: "warning",
          code: "REDUCER_TYPE_MISMATCH",
          message: `Channel "${name}" uses reducer "${reducer}" but type is "${ch.type}" (expected array)`,
          path,
        });
      }
    }

    if (reducer === "merge" || reducer === "mergeDeep") {
      if (ch.type !== "object" && ch.type !== "any") {
        diagnostics.push({
          severity: "warning",
          code: "REDUCER_TYPE_MISMATCH",
          message: `Channel "${name}" uses reducer "${reducer}" but type is "${ch.type}" (expected object)`,
          path,
        });
      }
    }

    if (reducer?.startsWith("custom:")) {
      const reducerName = reducer.slice("custom:".length);
      if (!registry.getReducer(reducerName)) {
        diagnostics.push({
          severity: "error",
          code: "UNREGISTERED_REDUCER",
          message:
            `Channel "${name}" uses reducer "custom:${reducerName}" but no reducer is registered. ` +
            `Call registry.registerReducer("${reducerName}", fn) or add imports: [{ reducers: "..." }] before validating or compiling.`,
          path,
        });
      }
    }
  }

  return diagnostics;
}

export function graphLintDiagnostics(spec: GraphSpec): Diagnostic[] {
  return [
    ...reachabilityDiagnostics(spec),
    ...channelReducerDiagnostics(spec),
    ...fanInLastWriteDiagnostics(spec),
  ];
}
