/**
 * Offline graph lint helpers used by validateSpec.
 */

import { findMergeableRouters, normalizeRunsOn, type MergeSpec } from "@flowgraph/spec";
import type { GraphSpec, Diagnostic, NodeSpec } from "@flowgraph/spec";
import { registry } from "../registry.js";
import { templateRootRefs } from "../node-policy.js";
import { childChannelRefsInMapping, stateMapOutEntries } from "../nodes/subgraph-merge.js";
import { isOutputNone, OUTPUTS_CHANNEL } from "./apply-output.js";
import { fanInLastWriteDiagnostics } from "./fan-in-warning.js";
import { RESERVED_STATE_CHANNELS } from "./state-annotation.js";
import { memoryLintDiagnostics } from "../memory/validate.js";
import { contextLintDiagnostics } from "../context/validate.js";
import { staticGraphDiagnostics } from "./static-diagnostics.js";
import {
  HITL_DEFAULT_ROUTE,
  hitlOutcomes,
  hitlRouteTargets,
  normalizeHitlRoutes,
} from "../nodes/hitl-routes.js";

/** Targets declared by a node's own `with.routes` (router or hitl); edges don't have to repeat them. */
export function declaredRouteTargets(spec: GraphSpec, id: string): string[] {
  const node = spec.nodes.find((n) => n.id === id);
  if (!node) return [];
  const w = (node.with ?? {}) as Record<string, unknown>;
  if (node.type === "hitl") return hitlRouteTargets(w);
  if (node.type !== "router") return [];
  const routes = w["routes"];
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return [];
  return Object.values(routes as Record<string, unknown>).flatMap((r) =>
    r && typeof r === "object" && typeof (r as { to?: unknown }).to === "string"
      ? [(r as { to: string }).to]
      : [],
  );
}

function outgoingTargets(spec: GraphSpec, from: string): string[] {
  const targets: string[] = nodeRouteTargets(spec, from);
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

export function nodeToolTargets(spec: GraphSpec, id: string): string[] {
  const node = spec.nodes.find((n) => n.id === id);
  if (!node || (node.type !== "agent" && node.type !== "intelligent")) return [];
  const withBlock = (node?.with ?? {}) as { tools?: Array<{ node?: string }>; agent?: string };
  const targets = (Array.isArray(withBlock.tools) ? withBlock.tools : []).flatMap((tool) => tool && typeof tool.node === "string" ? [tool.node] : []);
  // Reusable AGENT.md definitions resolve tools at run time.
  if (typeof withBlock.agent === "string" && withBlock.agent) targets.push(...spec.nodes.filter((n) => n.id !== id).map((n) => n.id));
  return [...new Set(targets)];
}

export function nodeRouteTargets(spec: GraphSpec, id: string): string[] {
  const node = spec.nodes.find((n) => n.id === id);
  const targets = declaredRouteTargets(spec, id);
  if (node?.on?.error?.startsWith("route:")) targets.push(node.on.error.slice(6));
  for (const hook of spec.runtime?.hooks ?? []) {
    if (!hook.do.startsWith("route:") || !["node:before", "node:after", "node:error"].includes(hook.on)) continue;
    if (hook.where?.nodeId !== undefined && hook.where.nodeId !== id) continue;
    if (hook.where?.nodeType !== undefined && hook.where.nodeType !== node?.type) continue;
    targets.push(hook.do.slice(6));
  }
  return [...new Set(targets)];
}

/** Public topology includes routes that do not require duplicate static edges. */
export function graphEdges(spec: GraphSpec): Array<{ from: string; to: string; label?: string }> {
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  for (const edge of spec.edges) {
    if (declaredRouteTargets(spec, edge.from).length) continue;
    if ("to" in edge) for (const to of Array.isArray(edge.to) ? edge.to : [edge.to]) edges.push({ from: edge.from, to });
    else for (const branch of edge.branch) edges.push({ from: edge.from, to: branch.to, ...(branch.when ? { label: branch.when } : branch.default ? { label: "default" } : {}) });
  }
  for (const node of spec.nodes) {
    for (const to of nodeRouteTargets(spec, node.id)) edges.push({ from: node.id, to, label: "route" });
  }
  return [...new Map(edges.map((edge) => [`${edge.from}:${edge.to}:${edge.label ?? ""}`, edge])).values()];
}

export function topologyDiagnostics(spec: GraphSpec): Diagnostic[] {
  const ids = new Set(["START", "END", ...spec.nodes.map((n) => n.id)]);
  const diagnostics = reachabilityDiagnostics(spec);
  for (const node of spec.nodes) {
    for (const target of [...nodeRouteTargets(spec, node.id), ...nodeToolTargets(spec, node.id)]) {
      if (!ids.has(target)) diagnostics.push({ severity: "error", code: "UNKNOWN_NODE_REF", message: `Node "${node.id}" references unknown target "${target}"`, path: `nodes.${node.id}` });
    }
  }
  return diagnostics;
}

function incomingSources(spec: GraphSpec, to: string): string[] {
  const sources: string[] = [];
  for (const node of spec.nodes) {
    if (nodeRouteTargets(spec, node.id).includes(to)) sources.push(node.id);
  }
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
  const tools = new Set(spec.nodes.flatMap((node) => nodeToolTargets(spec, node.id)));

  for (const node of spec.nodes) {
    if (!fromStart.has(node.id) && !tools.has(node.id)) {
      diagnostics.push({
        severity: "error",
        code: "UNREACHABLE_FROM_START",
        message: `Node "${node.id}" is not reachable from START`,
        path: `nodes.${node.id}`,
      });
    } else if (!toEnd.has(node.id) && !tools.has(node.id)) {
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

/** Extract channel names targeted by an `output` / `collect` mapping (`to` + `map` keys). */
export function channelsFromOutputMapping(mapping: unknown): string[] {
  if (mapping == null || isOutputNone(mapping)) return [];
  if (typeof mapping !== "object" || Array.isArray(mapping)) return [];
  const m = mapping as Record<string, unknown>;
  const names: string[] = [];
  if (typeof m["to"] === "string" && m["to"].trim()) names.push(m["to"].trim());
  if (m["map"] != null && typeof m["map"] === "object" && !Array.isArray(m["map"])) {
    names.push(...Object.keys(m["map"] as Record<string, unknown>).filter((k) => k.trim()));
  }
  return names;
}

function hasExplicitProjection(mapping: unknown): boolean {
  if (mapping == null || typeof mapping !== "object" || Array.isArray(mapping)) return false;
  const m = mapping as Record<string, unknown>;
  return (
    (typeof m["to"] === "string" && !!m["to"].trim()) ||
    (m["map"] != null && typeof m["map"] === "object" && !Array.isArray(m["map"]))
  );
}

/**
 * All state channel names written by a node's output/collect/stateMap.out,
 * including the reserved `outputs` channel for the default per-node slug
 * (unless opted out via `none`, or subgraph transparent state-merge when
 * output is omitted).
 */
export function collectNodeWriteChannels(node: GraphSpec["nodes"][number]): string[] {
  const withBlock = (node.with ?? {}) as Record<string, unknown>;
  const output = withBlock["output"];
  const names = new Set<string>(channelsFromOutputMapping(output));

  if (node.type === "map") {
    const collect = withBlock["collect"];
    for (const c of channelsFromOutputMapping(collect)) names.add(c);
    if (!isOutputNone(collect)) names.add(OUTPUTS_CHANNEL);
    return [...names];
  }

  if (node.type === "subgraph") {
    const out = stateMapOutEntries(withBlock);
    if (out) {
      // Keys are parent channels. Values are child channels or expressions.
      for (const channel of Object.keys(out)) names.add(channel);
      // stateMap.out replaces the default merge/slug path
      return [...names];
    }
    if (isOutputNone(output)) return [...names];
    // Explicit to/map: outputs slug + projections. Omitted output: child-state merge
    // (unknown channel set — do not auto-declare the outputs channel for merge).
    if (hasExplicitProjection(output)) names.add(OUTPUTS_CHANNEL);
    return [...names];
  }

  // Agents also write their with.context.history channel.
  const history = historyChannelOf(node);
  if (history) names.add(history);

  // Ordinary nodes: always write state.outputs.<nodeId> unless output: none.
  if (!isOutputNone(output)) names.add(OUTPUTS_CHANNEL);

  return [...names];
}

/** The with.context.history channel of an agent node, if it names one. */
export function historyChannelOf(node: GraphSpec["nodes"][number]): string | undefined {
  if (node.type !== "agent") return undefined;
  const ctx = ((node.with ?? {}) as { context?: { history?: unknown } }).context;
  const h = ctx?.history;
  return typeof h === "string" && h.trim() ? h : undefined;
}

/** Channel def used when auto-declaring the reserved per-node outputs bag. */
export const OUTPUTS_CHANNEL_DEF = {
  type: "object" as const,
  reducer: "mergeDeep" as const,
  default: {},
  description: "Per-node results keyed by node id (auto-written when output is omitted).",
};

/**
 * Ensure every channel written by nodes exists under `state.channels`.
 * Missing names are added as `{ type: "any" }` so LangGraph does not silently
 * drop updates. The reserved `outputs` channel is declared with mergeDeep.
 * Returns the same spec instance when nothing changes.
 */
export function ensureDeclaredOutputChannels(spec: GraphSpec): GraphSpec {
  const existing = { ...(spec.state?.channels ?? {}) };
  let changed = false;

  for (const node of spec.nodes) {
    for (const name of collectNodeWriteChannels(node)) {
      if (name in existing) continue;
      existing[name] =
        name === OUTPUTS_CHANNEL
          ? { ...OUTPUTS_CHANNEL_DEF }
          : name === historyChannelOf(node)
            ? { type: "messages" }
            : { type: "any" };
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
    // Reserved per-node bag — always auto-declared by ensureDeclaredOutputChannels.
    if (channel === OUTPUTS_CHANNEL) return;
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
      // An undeclared history channel is reported as CONTEXT_HISTORY_CHANNEL.
      if (channel === historyChannelOf(node)) continue;
      const withBlock = (node.with ?? {}) as Record<string, unknown>;
      let path = `nodes.${node.id}.with.output`;
      if (
        node.type === "map" &&
        channelsFromOutputMapping(withBlock["collect"]).includes(channel)
      ) {
        path = `nodes.${node.id}.with.collect`;
      } else if (node.type === "subgraph") {
        const out = stateMapOutEntries(withBlock);
        if (out && Object.prototype.hasOwnProperty.call(out, channel)) {
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
/**
 * Channel names that become LangGraph state attributes at compile time —
 * declared channels, auto-declared output targets, and reserved channels.
 */
export function channelNamesForCollisionCheck(spec: GraphSpec): Set<string> {
  const names = new Set(Object.keys(spec.state?.channels ?? {}));
  for (const node of spec.nodes) {
    for (const channel of collectNodeWriteChannels(node)) names.add(channel);
  }
  for (const reserved of RESERVED_STATE_CHANNELS) names.add(reserved);
  // buildStateAnnotation adds a placeholder `result` channel when the
  // annotation would otherwise be empty (aside from reserved channels).
  const reservedSet = new Set<string>(RESERVED_STATE_CHANNELS);
  const userChannels = [...names].filter((n) => !reservedSet.has(n));
  if (userChannels.length === 0) names.add("result");
  return names;
}

/**
 * LangGraph forbids using the same string as both a state channel and a node
 * id ("X is already being used as a state attribute…"). Catch this offline.
 */
export function nodeChannelNameCollisionDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const channels = channelNamesForCollisionCheck(spec);

  for (const node of spec.nodes) {
    if (!channels.has(node.id)) continue;
    diagnostics.push({
      severity: "error",
      code: "NODE_CHANNEL_NAME_COLLISION",
      message:
        `Node id "${node.id}" conflicts with state channel "${node.id}" — ` +
        `LangGraph cannot use the same name for a node and a state attribute. ` +
        `Rename the node (e.g. "${node.id}-node") or the channel.`,
      path: `nodes.${node.id}`,
    });
  }

  return diagnostics;
}

export function unconditionalFanOutDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const routerIds = new Set(
    spec.nodes
      .filter((n) => n.type === "router" || (n.type === "hitl" && declaredRouteTargets(spec, n.id).length > 0))
      .map((n) => n.id),
  );

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

/**
 * Subgraph nodes must identify the child via exactly one of `uses` (path/alias)
 * or `spec` (inline GraphSpec from bundling).
 */
export function subgraphRefDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const node of spec.nodes) {
    if (node.type !== "subgraph") continue;
    const hasUses = typeof node.uses === "string" && node.uses.trim().length > 0;
    const hasSpec =
      node.spec != null && typeof node.spec === "object" && Array.isArray(node.spec.nodes);
    if (hasUses && hasSpec) {
      diagnostics.push({
        severity: "error",
        code: "SUBGRAPH_REF_CONFLICT",
        message:
          `Node "${node.id}" sets both "uses" and "spec" — ` +
          `provide exactly one (path/alias via uses, or an inline GraphSpec via spec)`,
        path: `nodes.${node.id}`,
      });
    } else if (!hasUses && !hasSpec) {
      diagnostics.push({
        severity: "error",
        code: "SUBGRAPH_REF_MISSING",
        message:
          `Node "${node.id}" (type subgraph) requires "uses" (path or alias) or "spec" (inline GraphSpec)`,
        path: `nodes.${node.id}`,
      });
    }
  }
  return diagnostics;
}

export interface SubgraphOutputSite {
  graph: GraphSpec;
  placed: boolean;
  /** Node id, or the enclosing map id when the subgraph is anonymous. */
  id: string;
  /** Diagnostic path for `stateMap.out`. */
  path: string;
  uses?: string | undefined;
  inline?: GraphSpec | undefined;
  /** Parent channel → child channel or expression. Absent when `stateMap.out` is omitted. */
  out?: Record<string, string> | undefined;
}

/** Every subgraph node, including map inners and nested inline specs. */
export function subgraphOutputSites(spec: GraphSpec): SubgraphOutputSite[] {
  const sites: SubgraphOutputSite[] = [];
  const walk = (graph: GraphSpec, prefix: string) => {
    for (const node of graph.nodes ?? []) {
      if (node.type === "subgraph") {
        sites.push(siteFor(node, `${prefix}nodes.${node.id}.with.stateMap.out`, graph));
        if (node.spec) walk(node.spec, `${prefix}nodes.${node.id}.spec.`);
      }
      if (node.type === "map") {
        const inner = (node.with as { node?: NodeSpec } | undefined)?.node;
        if (inner && inner.type === "subgraph") {
          const label = inner.id || node.id;
          sites.push({
            ...siteFor(inner, `${prefix}nodes.${node.id}.with.node.with.stateMap.out`, graph),
            id: label,
          });
          if (inner.spec) walk(inner.spec, `${prefix}nodes.${node.id}.with.node.spec.`);
        }
      }
    }
  };
  walk(spec, "");
  return sites;
}

function siteFor(node: NodeSpec, path: string, graph: GraphSpec): SubgraphOutputSite {
  const uses = typeof node.uses === "string" && node.uses.trim() ? node.uses.trim() : undefined;
  return {
    graph,
    placed: node.runsOn !== undefined,
    id: node.id,
    path,
    ...(uses ? { uses } : {}),
    ...(node.spec ? { inline: node.spec } : {}),
    ...(stateMapOutEntries(node.with) ? { out: stateMapOutEntries(node.with) } : {}),
  };
}

/** Channels a child graph can produce: declared channels plus node write targets. */
export function knownChildChannels(child: GraphSpec): Set<string> {
  const names = new Set(Object.keys(child.state?.channels ?? {}));
  for (const node of child.nodes ?? []) {
    for (const channel of collectNodeWriteChannels(node)) names.add(channel);
  }
  return names;
}

export function unknownSubgraphOutputDiagnostics(site: SubgraphOutputSite, child: GraphSpec): Diagnostic[] {
  if (!site.out) return [];
  const known = knownChildChannels(child);
  const diagnostics: Diagnostic[] = [];
  for (const [parentChannel, expr] of Object.entries(site.out)) {
    for (const ref of childChannelRefsInMapping(expr)) {
      if (known.has(ref)) continue;
      diagnostics.push({
        severity: "error",
        code: "SUBGRAPH_OUTPUT_UNKNOWN",
        message:
          `Node "${site.id}" stateMap.out writes parent channel "${parentChannel}" from "${expr.trim()}", ` +
          `but "${ref}" is not a channel of the child graph.`,
        path: site.path,
      });
    }
  }
  return diagnostics;
}

/**
 * Flag `stateMap.out` values that name a child channel the inline child does
 * not have. File subgraphs are checked by `loadGraph`, which can read the child.
 */
export function subgraphOutputMappingDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const site of subgraphOutputSites(spec)) {
    if (!site.out || !site.inline) continue;
    diagnostics.push(...unknownSubgraphOutputDiagnostics(site, site.inline));
  }
  return diagnostics;
}

/**
 * `hitl` `with.routes`: only the modes with a closed set of answers can route, every
 * answer needs a route (or a `default`), and a route key that is not an answer is a typo.
 */
export function hitlRouteDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodeIds = new Set(["END", ...spec.nodes.map((n) => n.id)]);
  for (const node of spec.nodes) {
    if (node.type !== "hitl") continue;
    const w = (node.with ?? {}) as Record<string, unknown>;
    if (w["routes"] == null) continue;
    const path = `nodes.${node.id}.with.routes`;
    const routes = normalizeHitlRoutes(w["routes"]);
    const keys = Object.keys(routes);
    const mode = typeof w["mode"] === "string" ? w["mode"] : "approve";

    const known = hitlOutcomes(w);
    if (!known) {
      diagnostics.push({
        severity: "error",
        code: "HITL_ROUTES_MODE",
        message:
          `hitl node "${node.id}" has routes but mode "${mode}" has no fixed set of answers to route on — ` +
          `use approve, choice or review, or follow the node with a router.`,
        path,
      });
      continue;
    }

    for (const [key, route] of Object.entries(routes)) {
      if (!nodeIds.has(route.to)) {
        diagnostics.push({
          severity: "error",
          code: "HITL_ROUTE_UNKNOWN_TARGET",
          message: `hitl node "${node.id}" route "${key}" goes to unknown node "${route.to}"`,
          path: `${path}.${key}`,
        });
      }
    }

    const hasDefault = HITL_DEFAULT_ROUTE in routes;
    if (!known.dynamic) {
      for (const outcome of known.outcomes) {
        if (!(outcome in routes) && !hasDefault) {
          diagnostics.push({
            severity: "error",
            code: "HITL_ROUTE_MISSING",
            message:
              `hitl node "${node.id}" has no route for "${outcome}" — ` +
              `add it (or a "default" route), otherwise that answer fails the run`,
            path,
          });
        }
      }
      for (const key of keys) {
        if (key !== HITL_DEFAULT_ROUTE && !known.outcomes.includes(key)) {
          diagnostics.push({
            severity: "warning",
            code: "HITL_ROUTE_UNKNOWN_OUTCOME",
            message:
              `hitl node "${node.id}" route "${key}" never matches — answers are: ${known.outcomes.join(", ")}`,
            path: `${path}.${key}`,
          });
        }
      }
    } else if (!hasDefault) {
      diagnostics.push({
        severity: "warning",
        code: "HITL_ROUTES_NO_DEFAULT",
        message:
          `hitl node "${node.id}" has templated choices, so its answers are only known at run time — ` +
          `add a "default" route for answers without their own`,
        path,
      });
    }

    const targets = new Set(Object.values(routes).map((r) => r.to));
    for (const [i, edge] of spec.edges.entries()) {
      if (edge.from !== node.id) continue;
      const to = "to" in edge ? (Array.isArray(edge.to) ? edge.to : [edge.to]) : edge.branch.map((b) => b.to);
      if (to.some((t) => !targets.has(t))) {
        diagnostics.push({
          severity: "warning",
          code: "HITL_ROUTES_EDGE_IGNORED",
          message:
            `hitl node "${node.id}" routes on its answer, so edges leaving it that aren't route targets are ignored`,
          path: `edges[${i}]`,
        });
      }
    }
  }
  return diagnostics;
}

/** `hitl` `with.select` one/many picks from `with.artifacts`, so it needs them. */
export function hitlSelectDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const node of spec.nodes) {
    if (node.type !== "hitl") continue;
    const w = (node.with ?? {}) as Record<string, unknown>;
    if (w["select"] !== "one" && w["select"] !== "many") continue;
    const artifacts = w["artifacts"];
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "HITL_SELECT_NO_ARTIFACTS",
        message:
          `hitl node "${node.id}" sets select "${String(w["select"])}" but has no with.artifacts — ` +
          `there is nothing to pick from, so no selection can be made`,
        path: `nodes.${node.id}.with.artifacts`,
      });
    }
  }
  return diagnostics;
}

/**
 * A router straight after a human gate that only repeats the gate's answer can be folded into
 * the gate's `with.routes` — one node instead of two, no expressions. A recommendation
 * (`info`), not a problem, so it never fails `--strict`.
 */
export function hitlRouterMergeDiagnostics(spec: GraphSpec): Diagnostic[] {
  return findMergeableRouters(spec as unknown as MergeSpec).map(({ routerId, hitlId }) => ({
    severity: "info" as const,
    code: "HITL_ROUTER_MERGEABLE",
    message:
      `Router "${routerId}" only repeats the answer of hitl "${hitlId}" — ` +
      `move its routes onto the gate (with.routes) and remove the router. ` +
      `The desktop Builder does this with "Merge into HITL".`,
    path: `nodes.${routerId}`,
  }));
}

/**
 * A `demo` node that proves something can't be an agent tool (ADR-0019 §9): a tool call writes
 * no `state.outputs`, and an agent choosing its own assertions would make `passed` meaningless.
 */
export function provesObjective(node: { type?: unknown; with?: unknown } | undefined): boolean {
  if (node?.type !== "demo") return false;
  const w = (node.with ?? {}) as Record<string, unknown>;
  return w["objective"] != null || w["steps"] != null;
}

export function demoToolExposureDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const check = (node: NodeSpec, path: string): void => {
    const w = (node.with ?? {}) as { tools?: unknown; node?: NodeSpec };
    if (Array.isArray(w.tools)) {
      for (const tool of w.tools as Array<{ node?: unknown }>) {
        const target = spec.nodes.find((n) => n.id === tool?.node);
        if (!provesObjective(target)) continue;
        diagnostics.push({
          severity: "error",
          code: "DEMO_OBJECTIVE_AS_TOOL",
          message: `Node "${node.id ?? "map item"}" exposes demo node "${target!.id}" as a tool, but a demo node with an objective or steps can't be an agent tool`,
          path: `${path}.with.tools`,
        });
      }
    }
    if (w.node) check(w.node, `${path}.with.node`);
  };
  for (const node of spec.nodes) check(node, `nodes.${node.id}`);
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Placement (`runsOn`) — ADR-0020
// ---------------------------------------------------------------------------

const GATE_NODE_TYPES = new Set(["hitl", "workshop", "wait"]);

/** Child nodes carried inside a node: the inline subgraph spec and a `map` inner node. */
function childNodesOf(node: NodeSpec): NodeSpec[] {
  const out: NodeSpec[] = [];
  if (node.spec) out.push(...(node.spec.nodes ?? []));
  const inner = (node.with as { node?: NodeSpec } | undefined)?.node;
  if (node.type === "map" && inner && typeof inner === "object") out.push(inner);
  return out;
}

/** Node types that cannot be wrapped in a one-node child graph: `map` fans out, `router` returns a goto. */
export const UNPLACEABLE_TYPES = new Set(["map", "router"]);

export function unplaceableMessage(id: string, type: string): string {
  return (
    `Node "${id}" (type ${type}) cannot set runsOn: ${type} nodes cannot run remotely. ` +
    `Wrap it in a subgraph and place the subgraph.`
  );
}

/** Scopes a worker running a wrapped node does not have: it sees only the node's `input`. */
const COORDINATOR_ONLY_SCOPES = new Set(["state", "config", "issues"]);

function withTemplates(value: unknown, at: string, out: Array<{ at: string; text: string }>, depth = 0): void {
  if (depth > 32) return;
  if (typeof value === "string") out.push({ at, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => withTemplates(v, `${at}[${i}]`, out, depth + 1));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) withTemplates(v, `${at}.${k}`, out, depth + 1);
  }
}

/**
 * A placed non-subgraph node runs as a one-node graph that receives only its resolved `input`
 * (ADR-0020 §2). Templates in its `with` that read coordinator state would render empty there, and
 * an `input` key named like the node collides with its node id as a channel.
 * `with.output` and the node's `when` / `input` are evaluated on the coordinator, so they may read state.
 */
function wrappedNodeDiagnostics(node: NodeSpec, path: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const found: Array<{ at: string; text: string }> = [];
  for (const [k, v] of Object.entries((node.with ?? {}) as Record<string, unknown>)) {
    if (k === "output") continue;
    withTemplates(v, `with.${k}`, found);
  }
  for (const { at, text } of found) {
    for (const ref of templateRootRefs(text, COORDINATOR_ONLY_SCOPES)) {
      out.push({
        severity: "error",
        code: "PLACEMENT_STATE_REFERENCE",
        message:
          `Placed node "${node.id}" reads "${ref}" in ${at}, but on the worker it only sees its own input, so this would render empty. ` +
          `Pass the value through the node's input (input: { x: "{{ ${ref} }}" } and read {{ input.x }}), ` +
          `or place a subgraph with stateMap.in instead.`,
        path: `${path}.${at}`,
      });
    }
  }
  const input = (node as { input?: unknown }).input;
  if (input && typeof input === "object" && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, node.id)) {
    out.push({
      severity: "error",
      code: "PLACEMENT_INPUT_ID_COLLISION",
      message:
        `Placed node "${node.id}" has an input key named "${node.id}". Its input becomes channels of the child graph, ` +
        `and a channel cannot share a name with a node id. Rename the input key.`,
      path: `${path}.input.${node.id}`,
    });
  }
  return out;
}

/** Describes a human gate in `node` itself or in the inline children below it, else undefined. */
function findGate(node: NodeSpec): string | undefined {
  const w = (node.with ?? {}) as Record<string, unknown>;
  if (node.type === "hitl" || node.type === "workshop") return `a ${node.type} node ("${node.id}")`;
  if (node.type === "wait" && (w["until"] != null || w["signal"] != null || w["webhook"] != null)) {
    return `a wait node ("${node.id}") that waits on until/signal/webhook`;
  }
  if (node.type === "agent" && Array.isArray(w["tools"]) && JSON.stringify(w["tools"]).includes('"ask_human"')) {
    return `an agent ("${node.id}") with the ask_human tool`;
  }
  for (const child of childNodesOf(node)) {
    const found = findGate(child);
    if (found) return found;
  }
  return undefined;
}

/** True when `graph` (or any inline child below it) has a node with `runsOn`. */
export function graphHasPlacement(graph: GraphSpec): boolean {
  const walk = (nodes: NodeSpec[]): boolean =>
    nodes.some((n) => n.runsOn !== undefined || walk(childNodesOf(n)));
  return walk(graph.nodes ?? []);
}

export function placementNestedMessage(id: string): string {
  return (
    `Node "${id}" sets runsOn, but its subgraph also contains a node with runsOn. ` +
    `Nested placement is not supported: place the whole subgraph, or place its inner nodes, not both.`
  );
}

export function placementNotTopLevelMessage(id: string): string {
  return (
    `Node "${id}" sets runsOn inside a subgraph. Only top-level nodes are placed, so this runsOn would be ignored ` +
    `and the node run on the coordinator. Place the subgraph node instead, or move the node to the top level.`
  );
}

/**
 * `runsOn` rules that need only the spec (inline children included):
 * - not allowed on hitl / workshop / wait (PLACEMENT_NOT_ALLOWED)
 * - a placed subgraph may not contain `runsOn` (PLACEMENT_NESTED)
 * - `runsOn` below the top level of an unplaced graph is rejected (PLACEMENT_NOT_TOP_LEVEL)
 * File-referenced (`uses:`) children are checked by `loadGraph`, which can read them.
 */
export function placementDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const warnedGate = new Set<string>();
  const check = (node: NodeSpec, path: string, depth: number, placedAncestor: boolean) => {
    if (node.runsOn !== undefined && depth > 0 && !placedAncestor) {
      // Only top-level nodes are resolved; below that, runsOn would be ignored and the node run locally.
      diagnostics.push({
        severity: "error",
        code: "PLACEMENT_NOT_TOP_LEVEL",
        message: placementNotTopLevelMessage(node.id),
        path: `${path}.runsOn`,
      });
    }
    if (node.runsOn !== undefined) {
      if (GATE_NODE_TYPES.has(node.type)) {
        diagnostics.push({
          severity: "error",
          code: "PLACEMENT_NOT_ALLOWED",
          message:
            `Node "${node.id}" (type ${node.type}) cannot set runsOn. ` +
            `Gates run on the coordinator; a gate inside a placed subgraph is forwarded to the coordinator's operator.`,
          path: `${path}.runsOn`,
        });
      }
      if (node.type === "subgraph" && node.spec && graphHasPlacement(node.spec)) {
        diagnostics.push({
          severity: "error",
          code: "PLACEMENT_NESTED",
          message: placementNestedMessage(node.id),
          path: `${path}.runsOn`,
        });
      }
      if (UNPLACEABLE_TYPES.has(node.type)) {
        diagnostics.push({
          severity: "error",
          code: "PLACEMENT_NOT_SUPPORTED",
          message: unplaceableMessage(node.id, node.type),
          path: `${path}.runsOn`,
        });
      }
      if (node.type !== "subgraph" && !GATE_NODE_TYPES.has(node.type) && !UNPLACEABLE_TYPES.has(node.type)) {
        diagnostics.push(...wrappedNodeDiagnostics(node, path));
      }
      const gate = !GATE_NODE_TYPES.has(node.type) ? findGate(node) : undefined;
      if (gate && !warnedGate.has(node.id)) {
        warnedGate.add(node.id);
        diagnostics.push({
          severity: "warning",
          code: "PLACEMENT_GATE_PHASE2",
          message:
            `Placed node "${node.id}" contains ${gate}. Gates inside placed subgraphs are forwarded in phase 2 (ADR-0020); ` +
            `until then the run fails with PLACEMENT_GATE_UNSUPPORTED if the gate is reached on the worker. ` +
            `Move the gate out of the placed subgraph, onto the coordinator.`,
          path: `${path}.runsOn`,
        });
      }
    }
    const placed = placedAncestor || node.runsOn !== undefined;
    if (node.spec) for (const child of node.spec.nodes ?? []) check(child, `${path}.spec.nodes.${child.id}`, depth + 1, placed);
    const inner = (node.with as { node?: NodeSpec } | undefined)?.node;
    if (node.type === "map" && inner && typeof inner === "object") check(inner, `${path}.with.node`, depth + 1, placed);
  };
  for (const node of spec.nodes ?? []) check(node, `nodes.${node.id}`, 0, false);
  return diagnostics;
}

/**
 * Warn when a static edge joins two nodes placed on the same labels and target:
 * each runs as its own hop through the coordinator.
 */
export function placementAdjacentHopDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const key = (n: NodeSpec) => {
    const p = normalizeRunsOn(n.runsOn!);
    return JSON.stringify([[...p.labels].sort(), p.target ?? null]);
  };
  for (const [i, edge] of spec.edges.entries()) {
    if (!("to" in edge)) continue;
    const from = byId.get(edge.from);
    if (!from || from.runsOn === undefined) continue;
    for (const toId of Array.isArray(edge.to) ? edge.to : [edge.to]) {
      const to = byId.get(toId);
      if (!to || to.runsOn === undefined || key(from) !== key(to)) continue;
      diagnostics.push({
        severity: "warning",
        code: "PLACEMENT_ADJACENT_HOPS",
        message:
          `Nodes "${from.id}" and "${to.id}" are adjacent and share the same runsOn, so each makes a round trip through the coordinator. ` +
          `Group them in a subgraph and place the subgraph to run both in one hop.`,
        path: `edges[${i}]`,
      });
    }
  }
  return diagnostics;
}

export function graphLintDiagnostics(spec: GraphSpec): Diagnostic[] {
  return [
    ...hitlRouteDiagnostics(spec),
    ...hitlSelectDiagnostics(spec),
    ...hitlRouterMergeDiagnostics(spec),
    ...topologyDiagnostics(spec),
    ...staticGraphDiagnostics(spec),
    ...demoToolExposureDiagnostics(spec),
    ...channelReducerDiagnostics(spec),
    ...undeclaredOutputChannelDiagnostics(spec),
    ...nodeChannelNameCollisionDiagnostics(spec),
    ...fanInLastWriteDiagnostics(spec),
    ...unconditionalFanOutDiagnostics(spec),
    ...subgraphRefDiagnostics(spec),
    ...subgraphOutputMappingDiagnostics(spec),
    ...placementDiagnostics(spec),
    ...placementAdjacentHopDiagnostics(spec),
    ...memoryLintDiagnostics(spec),
    ...contextLintDiagnostics(spec),
  ];
}
