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

/** Extract channel names targeted by an `output` / `collect` mapping. */
export function channelsFromOutputMapping(mapping: unknown): string[] {
  if (mapping == null || typeof mapping !== "object") return [];
  const m = mapping as Record<string, unknown>;
  if (typeof m["to"] === "string" && m["to"].trim()) return [m["to"].trim()];
  if (m["map"] != null && typeof m["map"] === "object" && !Array.isArray(m["map"])) {
    return Object.keys(m["map"] as Record<string, unknown>).filter((k) => k.trim());
  }
  return [];
}

/** All state channel names written by a node's output/collect/stateMap.out. */
export function collectNodeWriteChannels(node: GraphSpec["nodes"][number]): string[] {
  const withBlock = (node.with ?? {}) as Record<string, unknown>;
  const names = new Set<string>(channelsFromOutputMapping(withBlock["output"]));

  if (node.type === "map") {
    for (const c of channelsFromOutputMapping(withBlock["collect"])) names.add(c);
  }

  if (node.type === "subgraph") {
    const stateMap = withBlock["stateMap"];
    if (stateMap != null && typeof stateMap === "object" && !Array.isArray(stateMap)) {
      const out = (stateMap as { out?: unknown }).out;
      if (out != null && typeof out === "object" && !Array.isArray(out)) {
        for (const channel of Object.values(out as Record<string, unknown>)) {
          if (typeof channel === "string" && channel.trim()) names.add(channel.trim());
        }
      }
    }
  }

  return [...names];
}

/**
 * Ensure every channel written by nodes exists under `state.channels`.
 * Missing names are added as `{ type: "any" }` so LangGraph does not silently
 * drop updates. Returns the same spec instance when nothing changes.
 */
export function ensureDeclaredOutputChannels(spec: GraphSpec): GraphSpec {
  const existing = { ...(spec.state?.channels ?? {}) };
  let changed = false;

  for (const node of spec.nodes) {
    for (const name of collectNodeWriteChannels(node)) {
      if (name in existing) continue;
      existing[name] = { type: "any" };
      changed = true;
    }
  }

  if (!changed) return spec;
  return {
    ...spec,
    state: {
      ...(spec.state ?? { channels: {} }),
      channels: existing,
    },
  };
}

/**
 * LangGraph drops node-update keys that are not declared in the state annotation.
 * Flag any output/collect/stateMap.out target that is missing from state.channels.
 * (compileGraph auto-declares these; this lint still catches the authoring mistake.)
 */
export function undeclaredOutputChannelDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const declared = new Set(Object.keys(spec.state?.channels ?? {}));

  const pushIfUndeclared = (nodeId: string, channel: string, path: string) => {
    if (declared.has(channel)) return;
    diagnostics.push({
      severity: "error",
      code: "UNDECLARED_OUTPUT_CHANNEL",
      message:
        `Node "${nodeId}" writes to channel "${channel}" but it is not declared in state.channels — ` +
        `the write will be silently dropped at runtime unless the channel is declared ` +
        `(or auto-declared by the runtime/compiler)`,
      path,
    });
  };

  for (const node of spec.nodes) {
    for (const channel of collectNodeWriteChannels(node)) {
      const withBlock = (node.with ?? {}) as Record<string, unknown>;
      let path = `nodes.${node.id}.with.output`;
      if (
        node.type === "map" &&
        channelsFromOutputMapping(withBlock["collect"]).includes(channel)
      ) {
        path = `nodes.${node.id}.with.collect`;
      } else if (node.type === "subgraph") {
        const stateMap = withBlock["stateMap"];
        const out =
          stateMap != null && typeof stateMap === "object"
            ? (stateMap as { out?: Record<string, unknown> }).out
            : undefined;
        if (out && Object.values(out).includes(channel)) {
          path = `nodes.${node.id}.with.stateMap.out`;
        }
      }
      pushIfUndeclared(node.id, channel, path);
    }
  }

  return diagnostics;
}

/**
 * Warn when a non-router node has 2+ unconditional outgoing targets.
 * Parallel fan-out is valid, but often the author meant exclusive branching
 * (set `when` / `default` on a `branch` edge, or use a `router` node).
 */
export function unconditionalFanOutDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const routerIds = new Set(spec.nodes.filter((n) => n.type === "router").map((n) => n.id));

  for (const [i, edge] of spec.edges.entries()) {
    if (routerIds.has(edge.from)) continue;
    if ("branch" in edge && edge.branch) {
      const hasCondition = edge.branch.some((b) => b.when || b.default);
      if (edge.branch.length >= 2 && !hasCondition) {
        diagnostics.push({
          severity: "warning",
          code: "UNCONDITIONAL_FANOUT",
          message:
            `Node "${edge.from}" has ${edge.branch.length} branch targets with no when/default — ` +
            `this runs as parallel fan-out. Add conditions (or use a router) for exclusive routing.`,
          path: `edges[${i}]`,
        });
      }
      continue;
    }
    if ("to" in edge) {
      const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
      if (targets.length >= 2) {
        diagnostics.push({
          severity: "warning",
          code: "UNCONDITIONAL_FANOUT",
          message:
            `Node "${edge.from}" fans out to ${targets.length} targets with no conditions — ` +
            `all branches run in parallel. Click an edge in the builder to set when/default, ` +
            `or use a router node for exclusive routing.`,
          path: `edges[${i}]`,
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
    ...undeclaredOutputChannelDiagnostics(spec),
    ...fanInLastWriteDiagnostics(spec),
    ...unconditionalFanOutDiagnostics(spec),
  ];
}
