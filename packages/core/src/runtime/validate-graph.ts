/**
 * Offline graph lint helpers used by validateSpec.
 */

import { findMergeableRouters, hookVerbMessage, inputFieldChannel, inputValueProblem, normalizeRunsOn, type MergeSpec } from "@flowgraph/spec";
import type { GraphSpec, Diagnostic, NodeSpec } from "@flowgraph/spec";
import { registry } from "../registry.js";
import { isReservedChannel, templateRootRefs } from "../node-policy.js";
import { childChannelRefsInMapping, stateMapOutEntries } from "../nodes/subgraph-merge.js";
import { isOutputNone, keepsRawOutput, OUTPUTS_CHANNEL } from "./apply-output.js";
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
import type { Hook } from "../hooks/types.js";
import { KNOWN_PHASES, knownHookDirective } from "../hooks/builtin.js";
import { recoveryTargets } from "./routing-policy.js";
import { cronScheduleProblem, isKnownTimeZone } from "./cron-schedule.js";

/** Node ids on an edge `from`: one source, or every source of a barrier. */
function edgeFromIds(from: string | readonly string[]): string[] {
  return typeof from === "string" ? [from] : [...from];
}

/** A static edge whose `from` lists more than one node waits for all of them. */
function isJoinBarrier(from: string | readonly string[]): from is readonly string[] {
  return Array.isArray(from) && from.length > 1;
}

/** First node for each id. A later duplicate keeps the earlier node, as `find` did. */
export function nodesById(spec: GraphSpec): Map<string, NodeSpec> {
  const byId = new Map<string, NodeSpec>();
  if (!Array.isArray(spec.nodes)) return byId;
  for (const node of spec.nodes) {
    if (node != null && !byId.has(node.id)) byId.set(node.id, node);
  }
  return byId;
}

function routeTargetsOf(node: NodeSpec | undefined): string[] {
  if (!node) return [];
  const w = (node.with ?? {}) as Record<string, unknown>;
  if (node.type === "hitl") return hitlRouteTargets(w);
  if (node.type !== "router") return [];
  const routes = w["routes"];
  const values = Array.isArray(routes)
    ? routes
    : routes && typeof routes === "object"
      ? Object.values(routes as Record<string, unknown>)
      : [];
  return values.flatMap((r) =>
    r && typeof r === "object" && typeof (r as { to?: unknown }).to === "string"
      ? [(r as { to: string }).to]
      : [],
  );
}

/** Targets declared by a node's own `with.routes` (router or hitl); edges don't have to repeat them. */
export function declaredRouteTargets(spec: GraphSpec, id: string, byId?: Map<string, NodeSpec>): string[] {
  return routeTargetsOf((byId ?? nodesById(spec)).get(id));
}

export function nodeToolTargets(spec: GraphSpec, id: string): string[] {
  const nodes = recordNodes(spec.nodes);
  const node = nodes.find((n) => n.id === id);
  if (!node || (node.type !== "agent" && node.type !== "intelligent")) return [];
  const withBlock = (node?.with ?? {}) as { tools?: Array<{ node?: string }>; agent?: string };
  const targets = (Array.isArray(withBlock.tools) ? withBlock.tools : []).flatMap((tool) => tool && typeof tool.node === "string" ? [tool.node] : []);
  // Reusable AGENT.md definitions resolve tools at run time.
  if (typeof withBlock.agent === "string" && withBlock.agent) targets.push(...nodes.filter((n) => n.id !== id).map((n) => n.id));
  return [...new Set(targets)];
}

function routeTargetsFor(spec: GraphSpec, id: string, byId: Map<string, NodeSpec>): string[] {
  const node = byId.get(id);
  const targets = routeTargetsOf(node);
  if (node?.on?.error?.startsWith("route:")) targets.push(node.on.error.slice(6));
  const hooks = spec.runtime?.hooks;
  for (const hook of Array.isArray(hooks) ? hooks : []) {
    if (!hook || typeof hook.do !== "string" || !hook.do.startsWith("route:") || hook.on !== "node:error") continue;
    if (hook.where?.nodeId !== undefined && hook.where.nodeId !== id) continue;
    if (hook.where?.nodeType !== undefined && hook.where.nodeType !== node?.type) continue;
    targets.push(hook.do.slice(6));
  }
  return [...new Set(targets)];
}

export function nodeRouteTargets(spec: GraphSpec, id: string, byId?: Map<string, NodeSpec>): string[] {
  return routeTargetsFor(spec, id, byId ?? nodesById(spec));
}

/** Public topology includes routes that do not require duplicate static edges. */
export function graphEdges(spec: GraphSpec): Array<{ from: string; to: string; label?: string }> {
  const byId = nodesById(spec);
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  for (const edge of spec.edges) {
    const sources = edgeFromIds(edge.from);
    if (!Array.isArray(edge.from) && declaredRouteTargets(spec, edge.from, byId).length) continue;
    const barrier = isJoinBarrier(edge.from);
    if ("to" in edge) {
      for (const from of sources) for (const to of Array.isArray(edge.to) ? edge.to : [edge.to]) edges.push({ from, to, ...(barrier ? { label: "barrier" } : {}) });
    } else for (const branch of edge.branch) edges.push({ from: edge.from, to: branch.to, ...(branch.when ? { label: branch.when } : branch.default ? { label: "default" } : {}) });
  }
  for (const node of recordNodes(spec.nodes)) {
    const labelled = new Set<string>();
    if (node.type === "router" && Array.isArray(node.with?.routes)) {
      for (const [index, route] of (node.with.routes as Array<{ name?: string; when?: string; default?: boolean; to?: string }>).entries()) {
        if (typeof route?.to !== "string") continue;
        const label = route.name ?? (route.default === true ? "default" : route.when) ?? String(index);
        edges.push({ from: node.id, to: route.to, label });
        labelled.add(route.to);
      }
    } else {
      const routes = node.type === "hitl" ? normalizeHitlRoutes(node.with?.routes) : undefined;
      for (const [label, route] of Object.entries(routes ?? {})) if (typeof route?.to === "string") { edges.push({ from: node.id, to: route.to, label }); labelled.add(route.to); }
    }
    for (const to of nodeRouteTargets(spec, node.id, byId)) if (!labelled.has(to)) edges.push({ from: node.id, to, label: "route" });
  }
  return [...new Map(edges.map((edge) => [`${edge.from}:${edge.to}:${edge.label ?? ""}`, edge])).values()];
}

export function topologyDiagnostics(spec: GraphSpec): Diagnostic[] {
  const byId = nodesById(spec);
  const nodes = recordNodes(spec.nodes);
  const ids = new Set(["START", "END", ...nodes.map((n) => n.id)]);
  const diagnostics = reachabilityDiagnostics(spec, byId);
  for (const node of nodes) {
    for (const target of [...nodeRouteTargets(spec, node.id, byId), ...nodeToolTargets(spec, node.id)]) {
      if (!ids.has(target)) diagnostics.push({ severity: "error", code: "UNKNOWN_NODE_REF", message: `Node "${node.id}" references unknown target "${target}"`, path: `nodes.${node.id}` });
    }
  }
  return diagnostics;
}

type Neighbours = { outgoing: Map<string, string[]>; incoming: Map<string, string[]> };

function addNeighbour(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Incoming and outgoing ids, from one pass over the nodes and one over the edges. */
function neighbours(spec: GraphSpec, byId: Map<string, NodeSpec>): Neighbours {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    addNeighbour(outgoing, from, to);
    addNeighbour(incoming, to, from);
  };
  for (const node of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (node == null) continue;
    for (const to of routeTargetsFor(spec, node.id, byId)) link(node.id, to);
  }
  for (const edge of spec.edges) {
    const sources = edgeFromIds(edge.from);
    const targets: string[] = [];
    if ("to" in edge) {
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
      targets.push(...tos);
    }
    if ("branch" in edge) {
      for (const branch of edge.branch) targets.push(branch.to);
    }
    for (const from of sources) for (const to of targets) link(from, to);
  }
  return { outgoing, incoming };
}

function reachableFromStart(linked: Neighbours): Set<string> {
  const reachable = new Set<string>();
  const queue = (linked.outgoing.get("START") ?? []).filter((target) => target !== "END");
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of linked.outgoing.get(id) ?? []) {
      if (next !== "END" && !reachable.has(next)) queue.push(next);
    }
  }
  return reachable;
}

/** A later duplicate is visited here, so its own type can still reach END. */
function reachingEnd(spec: GraphSpec, linked: Neighbours): Set<string> {
  const canReach = new Set<string>();
  const queue: string[] = [];
  for (const node of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (node == null) continue;
    if (registry.get(node.type)?.capabilities?.terminal || (linked.outgoing.get(node.id) ?? []).includes("END")) {
      queue.push(node.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (canReach.has(id)) continue;
    canReach.add(id);
    for (const pred of linked.incoming.get(id) ?? []) {
      if (pred !== "START" && !canReach.has(pred)) queue.push(pred);
    }
  }
  return canReach;
}

/** Nodes reachable from START by following edges (excluding END). */
export function nodesReachableFromStart(spec: GraphSpec, byId = nodesById(spec)): Set<string> {
  return reachableFromStart(neighbours(spec, byId));
}

/** Nodes that can eventually reach END. */
export function nodesThatReachEnd(spec: GraphSpec, byId = nodesById(spec)): Set<string> {
  return reachingEnd(spec, neighbours(spec, byId));
}

export function reachabilityDiagnostics(spec: GraphSpec, byId = nodesById(spec)): Diagnostic[] {
  const linked = neighbours(spec, byId);
  const diagnostics: Diagnostic[] = [];
  const fromStart = reachableFromStart(linked);
  const toEnd = reachingEnd(spec, linked);
  const nodes = recordNodes(spec.nodes);
  const tools = new Set(nodes.flatMap((node) => nodeToolTargets(spec, node.id)));

  for (const node of nodes) {
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
    const path = `state.channels.${name}`;
    if (!ch || typeof ch !== "object") {
      diagnostics.push({ severity: "error", code: "SCHEMA_ERROR", path, message: "Expected object" });
      continue;
    }
    const reducer = ch.reducer;
    if (reducer !== undefined && typeof reducer !== "string") {
      diagnostics.push({ severity: "error", code: "SCHEMA_ERROR", path: `${path}.reducer`, message: "Expected string" });
      continue;
    }

    if (reducer === "append") {
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

    if (typeof reducer === "string" && reducer.startsWith("custom:")) {
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
    if (keepsRawOutput(collect)) names.add(OUTPUTS_CHANNEL);
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
    // Explicit to/map: outputs slug (unless raw: false) + projections. Omitted output:
    // child-state merge (unknown channel set — do not auto-declare the outputs channel for merge).
    if (hasExplicitProjection(output) && keepsRawOutput(output)) names.add(OUTPUTS_CHANNEL);
    return [...names];
  }

  // Agents also write their with.context.history channel.
  const history = historyChannelOf(node);
  if (history) names.add(history);

  // Ordinary nodes: write state.outputs.<nodeId> unless output: none or raw: false.
  if (keepsRawOutput(output)) names.add(OUTPUTS_CHANNEL);

  return [...names];
}

/** The with.context.history channel of an agent node, if it names one. */
export function historyChannelOf(node: GraphSpec["nodes"][number]): string | undefined {
  if (node.type !== "agent") return undefined;
  const ctx = ((node.with ?? {}) as { context?: { history?: unknown } }).context;
  const h = ctx?.history;
  return typeof h === "string" && h.trim() ? h : undefined;
}

/**
 * Channel def used when auto-declaring the reserved per-node outputs bag.
 * `merge` is shallow: each write `{ [nodeId]: result }` replaces that node's
 * whole previous result, so fields a later run no longer returns do not linger.
 */
export const OUTPUTS_CHANNEL_DEF = {
  type: "object" as const,
  reducer: "merge" as const,
  default: {},
  description: "Per-node results keyed by node id; each node's latest result replaces its previous one.",
};

/**
 * Ensure every channel written by nodes exists under `state.channels`.
 * Missing names are added as `{ type: "any" }` so LangGraph does not silently
 * drop updates. The reserved `outputs` channel is declared with a shallow
 * `merge`, so each node's latest result replaces its previous one.
 * Returns the same spec instance when nothing changes.
 */
export function ensureDeclaredOutputChannels(spec: GraphSpec): GraphSpec {
  const existing = { ...(spec.state?.channels ?? {}) };
  let changed = false;

  // A declared input is seeded into the channel of the same name.
  for (const field of Array.isArray(spec.inputs) ? spec.inputs : []) {
    if (!field || typeof field.key !== "string" || field.key in existing) continue;
    existing[field.key] = inputFieldChannel(field);
    changed = true;
  }

  for (const node of recordNodes(spec.nodes)) {
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
 * Flag any output/collect/stateMap.out target that is missing from state.channels.
 * compileGraph declares these as `type: any` with last-write-wins, so the write is
 * kept; this is a warning that the channel's type and reducer are not stated.
 */
export function undeclaredOutputChannelDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const declared = new Set([
    ...Object.keys(spec.state?.channels ?? {}),
    ...(Array.isArray(spec.inputs) ? spec.inputs : []).flatMap((field) => (typeof field?.key === "string" ? [field.key] : [])),
  ]);

  const pushIfUndeclared = (nodeId: string, channel: string, path: string) => {
    if (declared.has(channel)) return;
    // Reserved per-node bag — always auto-declared by ensureDeclaredOutputChannels.
    if (channel === OUTPUTS_CHANNEL) return;
    diagnostics.push({
      severity: "warning",
      code: "UNDECLARED_OUTPUT_CHANNEL",
      message:
        `Node "${nodeId}" writes to channel "${channel}", which is not declared in state.channels. ` +
        `The channel is declared for you as type any with last-write-wins; declare it to set its type and reducer.`,
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
  const byId = nodesById(spec);
  const routerIds = new Set(
    spec.nodes
      .filter((n) => n.type === "router" || (n.type === "hitl" && declaredRouteTargets(spec, n.id, byId).length > 0))
      .map((n) => n.id),
  );

  for (const [i, edge] of spec.edges.entries()) {
    if (!Array.isArray(edge.from) && routerIds.has(edge.from)) continue;
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
      if (!edge.branch.some((entry) => entry.default === true)) {
        diagnostics.push({
          severity: "warning",
          code: "BRANCH_NO_DEFAULT",
          message: `Edge from "${edge.from}" has no default. A run with no matching when fails.`,
          path: `edges[${i}]`,
        });
      }
      continue;
    }
  }

  return diagnostics;
}

export function routerNoDefaultDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const node of spec.nodes) {
    if (node.type !== "router") continue;
    const withBlock = node.with as { mode?: string; routes?: Array<{ default?: boolean }> } | undefined;
    const routes = withBlock?.routes;
    if ((withBlock?.mode ?? "rules") !== "rules" || !Array.isArray(routes)) continue;
    if (routes.some((route) => route?.default === true)) continue;
    diagnostics.push({
      severity: "warning",
      code: "ROUTER_NO_DEFAULT",
      message: `Router "${node.id}" has no default. A run with no matching when fails.`,
      path: `nodes.${node.id}.with.routes`,
    });
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
  /** Child keys set by `stateMap.in`. */
  inKeys: string[];
  /** Child keys set by the node's `input` object. Absent when `input` is not a literal object. */
  inputKeys?: string[] | undefined;
}

/** Every subgraph node, including map inners and nested inline specs. */
export function subgraphOutputSites(spec: GraphSpec): SubgraphOutputSite[] {
  const sites: SubgraphOutputSite[] = [];
  const walk = (graph: GraphSpec, prefix: string) => {
    if (!Array.isArray(graph?.nodes)) return;
    for (const node of graph.nodes) {
      if (!isRecord(node)) continue;
      if (node.type === "subgraph") {
        const specNode = node as unknown as NodeSpec;
        sites.push(siteFor(specNode, `${prefix}nodes.${specNode.id}.with.stateMap.out`, graph));
        if (isRecord(specNode.spec)) walk(specNode.spec as GraphSpec, `${prefix}nodes.${specNode.id}.spec.`);
      }
      if (node.type === "map") {
        const inner = (node.with as { node?: unknown } | undefined)?.node;
        if (!isRecord(inner) || inner.type !== "subgraph") continue;
        const body = inner as unknown as NodeSpec;
        const label = typeof body.id === "string" && body.id ? body.id : String(node.id ?? "");
        sites.push({
          ...siteFor(body, `${prefix}nodes.${String(node.id)}.with.node.with.stateMap.out`, graph),
          id: label,
        });
        if (isRecord(body.spec)) walk(body.spec, `${prefix}nodes.${String(node.id)}.with.node.spec.`);
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
    inKeys: stateMapInKeys(node.with),
    ...(literalInputKeys(node) ? { inputKeys: literalInputKeys(node) } : {}),
  };
}

function stateMapInKeys(config: unknown): string[] {
  const map = isRecord(config) && isRecord(config["stateMap"]) ? config["stateMap"]["in"] : undefined;
  return isRecord(map) ? Object.keys(map) : [];
}

function literalInputKeys(node: NodeSpec): string[] | undefined {
  const input = (node as { input?: unknown }).input;
  if (input === undefined) return [];
  return isRecord(input) ? Object.keys(input) : undefined;
}

/** Channels a child graph can produce: declared channels plus node write targets. */
export function knownChildChannels(child: GraphSpec): Set<string> {
  const names = new Set(Object.keys(child.state?.channels ?? {}));
  for (const field of Array.isArray(child.inputs) ? child.inputs : []) {
    if (typeof field?.key === "string") names.add(field.key);
  }
  for (const node of recordNodes(child.nodes)) {
    for (const channel of collectNodeWriteChannels(node)) names.add(channel);
  }
  return names;
}

/** The child channels a parent can read: the declared `outputs` when there are any, else every channel. */
export function exposedChildChannels(child: GraphSpec): Set<string> {
  const outputs = Array.isArray(child.outputs) ? child.outputs : [];
  return outputs.length > 0
    ? new Set(outputs.flatMap((field) => (typeof field?.key === "string" ? [field.key] : [])))
    : knownChildChannels(child);
}

export function unknownSubgraphOutputDiagnostics(site: SubgraphOutputSite, child: GraphSpec): Diagnostic[] {
  if (!site.out) return [];
  const known = exposedChildChannels(child);
  const declared = Array.isArray(child.outputs) && child.outputs.length > 0;
  const diagnostics: Diagnostic[] = [];
  for (const [parentChannel, expr] of Object.entries(site.out)) {
    for (const ref of childChannelRefsInMapping(expr)) {
      if (known.has(ref)) continue;
      diagnostics.push({
        severity: "error",
        code: "SUBGRAPH_OUTPUT_UNKNOWN",
        message:
          `Node "${site.id}" stateMap.out writes parent channel "${parentChannel}" from "${expr.trim()}", ` +
          (declared
            ? `but "${ref}" is not one of the child graph's declared outputs (${[...known].join(", ")}).`
            : `but "${ref}" is not a channel of the child graph.`),
        path: site.path,
      });
    }
  }
  return diagnostics;
}

/**
 * The call boundary, checked statically: a key the call sets that the child does not declare,
 * and a required child input that nothing in the call or the parent supplies. A same-name parent
 * channel is copied in implicitly, so it counts as supplied.
 */
export function subgraphInputDiagnostics(site: SubgraphOutputSite, child: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const accepted = knownChildChannels(child);
  const base = site.path.replace(/\.with\.stateMap\.out$/, "");
  const explicit = [...site.inKeys, ...(site.inputKeys ?? [])];
  for (const key of explicit) {
    if (accepted.has(key) || isReservedChannel(key)) continue;
    diagnostics.push({
      severity: "error",
      code: "SUBGRAPH_INPUT_UNKNOWN",
      message: `Node "${site.id}" passes "${key}" to the child graph, which declares no input or channel named "${key}".`,
      path: base,
    });
  }
  if (site.inputKeys === undefined) return diagnostics;
  const supplied = new Set([
    ...explicit,
    ...Object.keys(ensureDeclaredOutputChannels(site.graph).state?.channels ?? {}),
  ]);
  for (const field of Array.isArray(child.inputs) ? child.inputs : []) {
    if (!field?.required || field.default !== undefined || supplied.has(field.key)) continue;
    diagnostics.push({
      severity: "error",
      code: "SUBGRAPH_INPUT_MISSING",
      message: `Node "${site.id}" does not supply the child graph's required input "${field.key}". Pass it with input or stateMap.in.`,
      path: base,
    });
  }
  return diagnostics;
}

/**
 * Flag `stateMap.out` values that name a child channel the inline child does
 * not have, and calls that break its declared inputs. File subgraphs are checked
 * by `loadGraph`, which can read the child.
 */
export function subgraphOutputMappingDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const site of subgraphOutputSites(spec)) {
    if (!site.inline) continue;
    if (site.out) diagnostics.push(...unknownSubgraphOutputDiagnostics(site, site.inline));
    diagnostics.push(...subgraphInputDiagnostics(site, site.inline));
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
      if (!edgeFromIds(edge.from).includes(node.id)) continue;
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
        const target = (Array.isArray(spec.nodes) ? spec.nodes : []).find((n) => n != null && n.id === tool?.node);
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
  for (const node of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (!isRecord(node)) continue;
    check(node as NodeSpec, `nodes.${String(node.id)}`);
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Placement (`runsOn`) — ADR-0020
// ---------------------------------------------------------------------------

const GATE_NODE_TYPES = new Set(["hitl", "workshop", "wait"]);

/** Child nodes carried inside a node: the inline subgraph spec and a `map` inner node. */
function childNodesOf(node: NodeSpec): NodeSpec[] {
  const out: NodeSpec[] = [];
  const specNodes = (node.spec as { nodes?: unknown } | undefined)?.nodes;
  if (Array.isArray(specNodes)) {
    for (const child of specNodes) if (isRecord(child)) out.push(child as unknown as NodeSpec);
  }
  const inner = (node.with as { node?: unknown } | undefined)?.node;
  if (node.type === "map" && isRecord(inner)) out.push(inner as unknown as NodeSpec);
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
  if (input !== undefined && typeof input !== "string" && !isRecord(input)) {
    out.push({
      severity: "error",
      code: "PLACEMENT_INPUT_NOT_OBJECT",
      message:
        `Placed node "${node.id}" has an input that is not an object. Its input becomes channels of the child graph on the worker, ` +
        `so it must be an object of named values.`,
      path: `${path}.input`,
    });
  }
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
  const walk = (nodes: unknown): boolean =>
    Array.isArray(nodes) &&
    nodes.some((n) => isRecord(n) && ((n as NodeSpec).runsOn !== undefined || walk(childNodesOf(n as NodeSpec))));
  return walk(graph?.nodes);
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
          code: "PLACEMENT_GATE_NOT_FORWARDED",
          message:
            `Placed node "${node.id}" contains ${gate}. Gates inside placed subgraphs are not forwarded (ADR-0020); ` +
            `the run fails with PLACEMENT_GATE_UNSUPPORTED if the gate is reached on the worker. ` +
            `Move the gate out of the placed subgraph, onto the coordinator.`,
          path: `${path}.runsOn`,
        });
      }
    }
    const placed = placedAncestor || node.runsOn !== undefined;
    const children = (node.spec as { nodes?: unknown } | undefined)?.nodes;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (isRecord(child)) check(child as unknown as NodeSpec, `${path}.spec.nodes.${String(child.id)}`, depth + 1, placed);
      }
    }
    const inner = (node.with as { node?: unknown } | undefined)?.node;
    if (node.type === "map" && isRecord(inner)) check(inner as unknown as NodeSpec, `${path}.with.node`, depth + 1, placed);
  };
  for (const node of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (isRecord(node)) check(node as NodeSpec, `nodes.${String(node.id)}`, 0, false);
  }
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
    for (const fromId of edgeFromIds(edge.from)) {
      const from = byId.get(fromId);
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
  }
  return diagnostics;
}

/**
 * Nodes whose `to` edges the compiler does not install.
 * A router always declares routes. A `hitl` node does when `with.routes` names targets.
 * Matches `declaresRoutes` in the compiler.
 */
function routeDeclaringIds(spec: GraphSpec): Set<string> {
  const byId = nodesById(spec);
  return new Set(
    recordNodes(spec.nodes)
      .filter((n) => n.type === "router" || (n.type === "hitl" && declaredRouteTargets(spec, n.id, byId).length > 0))
      .map((n) => n.id),
  );
}

/**
 * Static successors only. Conditional branches are omitted, and so are `to`
 * edges out of a router or a `hitl` node that declares routes. The compiler
 * skips those edges and follows the declared route, so they are not paths the
 * run always takes.
 *
 * Error-recovery routes stay. On success the compiler still follows the node's
 * static `to` edges (`normalTargets`). A recovery route replaces them only
 * when the node fails, so the success path remains a static successor.
 */
function staticSuccessors(spec: GraphSpec): Map<string, string[]> {
  const routed = routeDeclaringIds(spec);
  const adj = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    if (to === "END" || from === "END") return;
    const next = adj.get(from) ?? [];
    if (!next.includes(to)) next.push(to);
    adj.set(from, next);
  };
  for (const edge of spec.edges) {
    if (!("to" in edge)) continue;
    const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
    for (const from of edgeFromIds(edge.from)) {
      if (routed.has(from)) continue;
      for (const to of tos) add(from, to);
    }
  }
  return adj;
}

/** Shortest static hop count from START. Absent when no static path exists. */
function hopDistances(adj: Map<string, string[]>): Map<string, number> {
  const dist = new Map<string, number>([["START", 0]]);
  const queue = ["START"];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = dist.get(id)!;
    for (const next of adj.get(id) ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return dist;
}

function reaches(adj: Map<string, string[]>, start: string, goal: string): boolean {
  if (start === goal) return true;
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (!seen.add(id)) continue;
    for (const next of adj.get(id) ?? []) {
      if (next === goal) return true;
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

/**
 * A node with several plain inbound edges from parallel branches of different
 * lengths runs once per branch. A barrier edge (`from` as a list) waits for
 * every source, so it is not warned about.
 */
export function unevenFanInDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const adj = staticSuccessors(spec);
  const dist = hopDistances(adj);
  const nodeIds = new Set(spec.nodes.map((n) => n.id));
  const inbound = new Map<string, string[]>();

  for (const edge of spec.edges) {
    if (!("to" in edge) || isJoinBarrier(edge.from)) continue;
    const source = edgeFromIds(edge.from)[0];
    if (!source) continue;
    for (const to of Array.isArray(edge.to) ? edge.to : [edge.to]) {
      if (!nodeIds.has(to)) continue;
      const list = inbound.get(to) ?? [];
      if (!list.includes(source)) list.push(source);
      inbound.set(to, list);
    }
  }

  for (const [nodeId, sources] of inbound) {
    if (sources.length < 2) continue;
    const uneven: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        const a = sources[i]!;
        const b = sources[j]!;
        // A source that can reach the other is a loop or a sequence, not a parallel branch.
        if (reaches(adj, a, b) || reaches(adj, b, a)) continue;
        const da = dist.get(a);
        const db = dist.get(b);
        if (da === undefined || db === undefined || da === db) continue;
        if (!uneven.includes(a)) uneven.push(a);
        if (!uneven.includes(b)) uneven.push(b);
      }
    }
    if (uneven.length < 2) continue;
    const detail = uneven.map((id) => `"${id}" (${dist.get(id)} hops from START)`).join(", ");
    const listed = uneven.map((id) => JSON.stringify(id)).join(", ");
    diagnostics.push({
      severity: "warning",
      code: "UNEVEN_FAN_IN",
      message:
        `Node "${nodeId}" has inbound edges from branches of uneven length (${detail}), so it runs once for each branch that finishes. ` +
        `Use one barrier edge { from: [${listed}], to: ${JSON.stringify(nodeId)} } so it runs after every listed source finishes.`,
      path: `nodes.${nodeId}`,
    });
  }
  return diagnostics;
}

/**
 * Errors for a static `from` list: fewer than two ids, unknown ids, duplicates,
 * reserved ids, a barrier aimed at END or at one of its own sources, a source
 * with a recovery route, and sources that are only reachable through a
 * conditional branch or a declared route (the barrier would never fire).
 */
export function barrierEdgeDiagnostics(spec: GraphSpec, hooks: Hook[] = []): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodes = recordNodes(spec.nodes);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = staticSuccessors(spec);
  const dist = hopDistances(adj);
  const reachable = nodesReachableFromStart(spec);

  spec.edges.forEach((edge, index) => {
    if (!Array.isArray(edge.from)) return;
    if (edge.from.length < 2) {
      diagnostics.push({
        severity: "error",
        code: "BARRIER_SOURCE_INVALID",
        message: "Edge from must list at least two node ids.",
        path: `edges[${index}].from`,
      });
    }

    const seen = new Set<string>();
    for (const id of edge.from) {
      if (seen.has(id)) {
        diagnostics.push({
          severity: "error",
          code: "DUPLICATE_EDGE_SOURCE",
          message: `Edge from lists "${id}" more than once.`,
          path: `edges[${index}].from`,
        });
        continue;
      }
      seen.add(id);
      if (id !== "START" && id !== "END" && !nodeIds.has(id)) {
        diagnostics.push({
          severity: "error",
          code: "UNKNOWN_NODE_REF",
          message: `Edge references unknown node "${id}"`,
          path: `edges[${index}].from`,
        });
      }
    }

    const targets = "to" in edge ? (Array.isArray(edge.to) ? edge.to : [edge.to]) : [];
    for (const target of targets) {
      if (target === "END" || !seen.has(target)) continue;
      diagnostics.push({
        severity: "error",
        code: "BARRIER_SELF_SOURCE",
        message: `Barrier edge lists "${target}" in from and also targets it. The join would wait for itself to finish.`,
        path: `edges[${index}]`,
      });
    }
    if (isJoinBarrier(edge.from) && targets.includes("END")) {
      diagnostics.push({
        severity: "error",
        code: "BARRIER_TARGET_END",
        message: "A barrier edge cannot target END. Point it at a join node, then add an edge from that node to END.",
        path: `edges[${index}].to`,
      });
    }
    const targetLabel = targets.filter((id) => id !== "END").join(", ") || "the join";
    for (const id of seen) {
      if (id === "END") {
        diagnostics.push({
          severity: "error",
          code: "BARRIER_SOURCE_INVALID",
          message: `"END" cannot be a barrier source. END is not a node that finishes, so the join would wait forever.`,
          path: `edges[${index}].from`,
        });
        continue;
      }
      if (id === "START") {
        diagnostics.push({
          severity: "error",
          code: "BARRIER_SOURCE_INVALID",
          message: `"START" cannot be a barrier source. List node ids in from.`,
          path: `edges[${index}].from`,
        });
        continue;
      }
      const node = byId.get(id);
      const recovery = node ? recoveryTargets(spec, node, hooks) : [];
      if (node && recovery.length > 0 && isJoinBarrier(edge.from)) {
        diagnostics.push({
          severity: "error",
          code: "BARRIER_RECOVERY_SOURCE",
          message:
            `Barrier source "${id}" has a recovery route to ${recovery.map((to) => `"${to}"`).join(", ")}. ` +
            "If it fails, the join still runs, at the same time as that route.",
          path: `edges[${index}].from`,
        });
      }
      if (!isJoinBarrier(edge.from) || !nodeIds.has(id) || dist.has(id) || !reachable.has(id)) continue;
      diagnostics.push({
        severity: "error",
        code: "BARRIER_CONDITIONAL_SOURCE",
        message:
          `Barrier source "${id}" on the edge to "${targetLabel}" can only be reached through a conditional branch or a declared route. ` +
          "The join waits for every listed source, so it would not run when that path is skipped.",
        path: `edges[${index}].from`,
      });
    }
  });
  return diagnostics;
}

export function defaultModelDiagnostics(spec: GraphSpec): Diagnostic[] {
  const defaults = spec.config?.defaults;
  if (!defaults?.model || defaults.provider) return [];
  return [{
    severity: "warning",
    code: "DEFAULT_MODEL_IGNORED",
    message: "config.defaults.model is ignored unless config.defaults.provider is set",
    path: "config.defaults.model",
  }];
}

/**
 * True when every node, edge, and hook has the strings the body lints read.
 * A missing or non-string field is left to the schema diagnostic.
 */
function lintableGraph(spec: GraphSpec): boolean {
  if (!Array.isArray(spec.nodes) || !Array.isArray(spec.edges)) return false;
  for (const node of spec.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || typeof node.type !== "string") return false;
    const onError = (node.on as { error?: unknown } | undefined)?.error;
    if (onError !== undefined && typeof onError !== "string") return false;
    const routes = (node.with as { routes?: unknown } | undefined)?.routes;
    if (routes !== undefined && (typeof routes !== "object" || routes === null)) return false;
  }
  for (const edge of spec.edges) {
    if (!isRecord(edge)) return false;
    const from = edge.from;
    if (typeof from !== "string" && !(Array.isArray(from) && from.every((item) => typeof item === "string"))) return false;
    if ("to" in edge) {
      const to = edge.to;
      if (typeof to !== "string" && !(Array.isArray(to) && to.every((item) => typeof item === "string"))) return false;
    } else if (!Array.isArray(edge.branch) || edge.branch.some((entry) => !isRecord(entry) || typeof entry.to !== "string")) {
      return false;
    }
  }
  const hooks = spec.runtime?.hooks;
  if (hooks !== undefined && !Array.isArray(hooks)) return false;
  if (Array.isArray(hooks)) {
    for (const hook of hooks) {
      if (!isRecord(hook) || typeof hook.on !== "string" || typeof hook.do !== "string") return false;
    }
  }
  return true;
}

/**
 * Lints that read only one graph's own nodes, edges and channels. Run on each
 * nested graph (inline subgraph `spec`); the top level gets them, and the lints
 * that walk the whole tree, from {@link graphLintDiagnostics}.
 */
export function graphBodyLintDiagnostics(spec: GraphSpec): Diagnostic[] {
  if (!lintableGraph(spec)) return [];
  return [
    ...hitlRouteDiagnostics(spec),
    ...hitlSelectDiagnostics(spec),
    ...topologyDiagnostics(spec),
    ...channelReducerDiagnostics(spec),
    ...undeclaredOutputChannelDiagnostics(spec),
    ...nodeChannelNameCollisionDiagnostics(spec),
    ...fanInLastWriteDiagnostics(spec),
    ...unevenFanInDiagnostics(spec),
    ...barrierEdgeDiagnostics(spec),
    ...unconditionalFanOutDiagnostics(spec),
    ...routerNoDefaultDiagnostics(spec),
    ...defaultModelDiagnostics(spec),
    ...subgraphRefDiagnostics(spec),
    ...mapItemBindingDiagnostics(spec),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Nodes a walk can read. A null entry or a `nodes` value that is not a list is reported elsewhere. */
function recordNodes(nodes: unknown): NodeSpec[] {
  return Array.isArray(nodes) ? nodes.filter((node): node is NodeSpec => isRecord(node)) : [];
}

/** A nested graph's diagnostic, with its path under the node that holds it. */
function nested(d: Diagnostic, prefix: string): Diagnostic {
  return { ...d, path: d.path ? `${prefix}${d.path}` : prefix.replace(/\.$/, "") };
}

/** Most graphs and map bodies one spec may nest, counting the top level. */
export const MAX_GRAPH_NESTING = 32;

/**
 * Most nodes one spec may expand to, counting a nested graph or map body once
 * for each place it is used. Validation and compile visit every such place.
 */
export const MAX_GRAPH_NODES = 10_000;

interface GraphShape {
  /** Path of the first nested graph or map body beyond {@link MAX_GRAPH_NESTING}. */
  overflowPath?: string;
  /** Nodes once each nested graph and map body is counted at every place it is used. */
  nodes: number;
}

/**
 * Nesting depth and expanded size of a spec. Walks plain objects only, once per
 * object even when it is shared, so a cyclic or heavily shared programmatic
 * spec ends here instead of overflowing the stack or taking exponential time
 * in a schema parse or a later lint.
 */
function graphShape(spec: GraphSpec): GraphShape {
  // Levels each object spans (counting its own) and the nodes it expands to.
  const known = new WeakMap<object, { height: number; nodes: number }>();
  const open = new WeakSet<object>();
  class Overflow {
    constructor(readonly path: string) {}
  }
  const visit = (value: Record<string, unknown>, path: string, level: number, measure: () => { height: number; nodes: number }) => {
    if (level > MAX_GRAPH_NESTING || open.has(value)) throw new Overflow(path);
    const seen = known.get(value);
    if (seen) {
      if (level + seen.height - 1 > MAX_GRAPH_NESTING) throw new Overflow(path);
      return seen;
    }
    open.add(value);
    const result = measure();
    open.delete(value);
    known.set(value, result);
    return result;
  };
  const graph = (value: Record<string, unknown>, path: string, level: number) => visit(value, path, level, () => {
    let height = 1;
    let nodes = 0;
    for (const item of Array.isArray(value.nodes) ? value.nodes : []) {
      if (!isRecord(item)) continue;
      const child = node(item, `${path}nodes.${String(item.id)}`, level);
      height = Math.max(height, child.height);
      nodes += child.nodes;
    }
    return { height, nodes };
  });
  const node = (value: Record<string, unknown>, path: string, level: number): { height: number; nodes: number } => visit(value, path, level, () => {
    let height = 1;
    let nodes = 1;
    if (isRecord(value.spec)) {
      const inner = graph(value.spec, `${path}.spec.`, level + 1);
      height = Math.max(height, 1 + inner.height);
      nodes += inner.nodes;
    }
    const body = isRecord(value.with) ? value.with.node : undefined;
    if (isRecord(body)) {
      const inner = node(body, `${path}.with.node`, level + 1);
      height = Math.max(height, 1 + inner.height);
      nodes += inner.nodes;
    }
    return { height, nodes };
  });
  try {
    return { nodes: graph(spec as unknown as Record<string, unknown>, "", 1).nodes };
  } catch (err) {
    if (err instanceof Overflow) return { overflowPath: err.path.replace(/\.$/, "") || "nodes", nodes: Number.NaN };
    throw err;
  }
}

/** Diagnostics that stop every other check, because those walk each place a nested graph is used. */
export const GRAPH_SHAPE_CODES: ReadonlySet<string> = new Set(["GRAPH_NESTING_TOO_DEEP", "GRAPH_TOO_LARGE"]);

/**
 * `GRAPH_NESTING_TOO_DEEP` when graphs and map bodies nest beyond
 * {@link MAX_GRAPH_NESTING} or refer back to themselves, `GRAPH_TOO_LARGE` when
 * the spec expands to more than {@link MAX_GRAPH_NODES} nodes, else nothing.
 * Run it before any other walk of a programmatic spec.
 */
export function graphShapeDiagnostics(spec: GraphSpec): Diagnostic[] {
  const shape = graphShape(spec);
  if (shape.overflowPath !== undefined) {
    return [{
      severity: "error",
      code: "GRAPH_NESTING_TOO_DEEP",
      path: shape.overflowPath,
      message: `Graphs and map bodies nest more than ${MAX_GRAPH_NESTING} levels deep or refer back to themselves; flatten the nesting`,
    }];
  }
  if (shape.nodes > MAX_GRAPH_NODES) {
    return [{
      severity: "error",
      code: "GRAPH_TOO_LARGE",
      path: "nodes",
      message: `The graph expands to more than ${MAX_GRAPH_NODES.toLocaleString("en-US")} nodes, counting each nested graph and map body at every place it is used; use the nested graphs in fewer places or flatten the nesting`,
    }];
  }
  return [];
}

export interface GraphStructureOptions {
  /**
   * Also report the authoring checks that do not stop a compile: graph
   * `inputs` and `triggers` at every level, and the body lints of
   * {@link graphBodyLintDiagnostics} for nested graphs (the top level gets
   * those from `graphLintDiagnostics`).
   */
  lints?: boolean;
}

/**
 * The checks a graph must pass before it compiles, applied to the graph and
 * to every graph nested in it at any depth: each inline subgraph `spec` and
 * each `map` body (`with.node`, including a subgraph body's own `spec`).
 *
 * - nesting and expanded size stay within {@link MAX_GRAPH_NESTING} and
 *   {@link MAX_GRAPH_NODES} (otherwise only that is reported)
 * - hook events and verbs are known
 * - node ids are unique; edges name known nodes; `END` is never a source and
 *   `START` never an edge, router or hitl route target; there is an edge from `START`
 * - every node type is registered and its `with` matches that type's schema
 *
 * `compileGraph` refuses a spec with any error among these. `validateSpec`
 * passes `lints: true` and reports the rest of its lints alongside, and
 * `loadGraph` applies `validateSpec` to `uses` files.
 */
export function graphStructureDiagnostics(spec: GraphSpec, options: GraphStructureOptions = {}): Diagnostic[] {
  const shape = graphShapeDiagnostics(spec);
  if (shape.length) return shape;
  const out: Diagnostic[] = [];
  graphStructure(spec, "", out, options.lints === true, false);
  return out;
}

function stringOrStrings(value: unknown): value is string | string[] {
  return typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isNodeSpec(value: unknown): value is NodeSpec {
  return isRecord(value) && typeof value.id === "string" && typeof value.type === "string";
}

function isEdgeSpec(value: unknown): value is GraphSpec["edges"][number] {
  if (!isRecord(value) || !stringOrStrings(value.from)) return false;
  if ("to" in value) return stringOrStrings(value.to);
  return Array.isArray(value.branch) && value.branch.every((entry) => isRecord(entry) && typeof entry.to === "string");
}

function edgeTargets(edge: GraphSpec["edges"][number]): string[] {
  if ("to" in edge) return Array.isArray(edge.to) ? edge.to : [edge.to];
  return edge.branch.map((entry) => entry.to);
}

function graphStructure(spec: GraphSpec, prefix: string, out: Diagnostic[], lints: boolean, schemaChecked: boolean): void {
  const push = (...items: Diagnostic[]) => out.push(...(prefix ? items.map((d) => nested(d, prefix)) : items));
  // A map schema has already reported this value. The lint does not report it again.
  const shape = (code: string, path: string, message: string) => {
    if (!schemaChecked) push({ severity: "error", code, path, message });
  };
  const rawNodes = (Array.isArray(spec.nodes) ? spec.nodes : []) as unknown[];
  const rawEdges = (Array.isArray(spec.edges) ? spec.edges : []) as unknown[];
  const rawHooks = spec.runtime?.hooks as unknown;
  let malformed = !Array.isArray(spec.nodes) || !Array.isArray(spec.edges);

  if (!Array.isArray(spec.nodes)) shape("SCHEMA_ERROR", "nodes", "Expected array");
  if (spec.edges === undefined) shape("SCHEMA_ERROR", "edges", "Required");
  else if (!Array.isArray(spec.edges)) shape("SCHEMA_ERROR", "edges", "Expected array");
  if (rawHooks !== undefined && !Array.isArray(rawHooks)) shape("SCHEMA_ERROR", "runtime.hooks", "Expected array");
  for (const [index, hook] of (Array.isArray(rawHooks) ? rawHooks : []).entries()) {
    if (!isRecord(hook) || typeof hook.on !== "string") {
      shape("HOOK_PHASE_UNKNOWN", `runtime.hooks[${index}].on`, isRecord(hook) && hook.on !== undefined ? "Expected string" : "Required");
      continue;
    }
    if (typeof hook.do !== "string") {
      shape(hook.do === undefined ? "SCHEMA_ERROR" : "HOOK_DIRECTIVE_UNKNOWN", `runtime.hooks[${index}].do`, hook.do === undefined ? "Required" : "Expected string");
      continue;
    }
    if (!KNOWN_PHASES.has(hook.on)) push({ severity: "error", code: "HOOK_PHASE_UNKNOWN", path: `runtime.hooks[${index}].on`, message: `Unknown hook event "${hook.on}".` });
    if (!knownHookDirective(hook.do, hook.on)) push({ severity: "error", code: "HOOK_DIRECTIVE_UNKNOWN", path: `runtime.hooks[${index}].do`, message: `Hook directive "${hook.do}" is not valid for ${hook.on}. ${hookVerbMessage(hook.on)}` });
  }

  for (const [index, node] of rawNodes.entries()) {
    if (!isRecord(node)) {
      malformed = true;
      shape("SCHEMA_ERROR", `nodes[${index}]`, "Expected object");
      continue;
    }
    if (typeof node.id !== "string") {
      malformed = true;
      shape("SCHEMA_ERROR", `nodes[${index}].id`, node.id === undefined ? "Required" : "Expected string");
    }
    if (typeof node.type !== "string") {
      malformed = true;
      shape("SCHEMA_ERROR", `nodes[${index}].type`, node.type === undefined ? "Required" : "Expected string");
    }
  }
  const nodes = rawNodes.filter(isNodeSpec);

  const nodeIds = new Set<string>();
  for (const node of rawNodes) if (isRecord(node) && typeof node.id === "string") nodeIds.add(node.id);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) push({ severity: "error", code: "DUPLICATE_NODE_ID", message: `Duplicate node id: "${node.id}"`, ...(prefix ? { path: `nodes.${node.id}` } : {}) });
    seen.add(node.id);
  }

  for (const [index, edge] of rawEdges.entries()) {
    if (isEdgeSpec(edge)) continue;
    malformed = true;
    const from = isRecord(edge) ? edge.from : undefined;
    const to = isRecord(edge) && "to" in edge ? edge.to : undefined;
    if (!isRecord(edge) || !stringOrStrings(from)) {
      shape("SCHEMA_ERROR", `edges[${index}].from`, isRecord(edge) && from !== undefined ? "Expected string" : "Required");
    }
    if (!isRecord(edge) || ("to" in edge ? !stringOrStrings(to) : !Array.isArray(edge.branch))) {
      shape("SCHEMA_ERROR", `edges[${index}].to`, isRecord(edge) && to !== undefined ? "Expected string" : "Required");
    }
  }
  const edges = rawEdges.flatMap((edge, index) => (isEdgeSpec(edge) ? [{ edge, index }] : []));

  for (const { edge, index } of edges) {
    const check = (ref: string) => {
      if (ref === "START" || ref === "END") return;
      if (!nodeIds.has(ref)) push({ severity: "error", code: "UNKNOWN_NODE_REF", message: `Edge references unknown node "${ref}"`, path: `edges[${index}]` });
    };
    const targets = edgeTargets(edge);
    // A `from` list is checked in barrierEdgeDiagnostics, including unknown ids, START and END.
    if (!Array.isArray(edge.from)) {
      check(edge.from);
      if (edge.from === "END") {
        push({ severity: "error", code: "EDGE_FROM_END", path: `edges[${index}].from`, message: 'An edge cannot start at "END": the run has finished there. Start the edge at a node.' });
      }
    }
    for (const target of targets) check(target);
    if (targets.includes("START")) {
      push({ severity: "error", code: "EDGE_TO_START", path: `edges[${index}]`, message: 'An edge cannot lead to "START". Point it at the first node instead.' });
    }
  }

  if (!malformed && !edges.some(({ edge }) => (Array.isArray(edge.from) ? edge.from : [edge.from]).includes("START"))) {
    push({ severity: "error", code: "NO_START_EDGE", message: 'Graph has no edge from "START"', ...(prefix ? { path: "edges" } : {}) });
  }

  const allTargets = new Set<string>();
  for (const { edge } of edges) {
    for (const target of edgeTargets(edge)) allTargets.add(target);
  }
  // A router's or routing hitl's own `with.routes` also lead somewhere.
  const byId = nodesById(spec);
  for (const node of nodes) {
    const routeTargets = declaredRouteTargets(spec, node.id, byId);
    for (const t of routeTargets) allTargets.add(t);
    if (routeTargets.includes("START")) {
      push({ severity: "error", code: "ROUTE_TO_START", path: `nodes.${node.id}.with.routes`, message: `${node.type === "hitl" ? "Hitl" : "Router"} "${node.id}" has a route to "START". Route to the first node instead.` });
    }
  }
  if (!malformed) {
    for (const node of nodes) {
      if (!allTargets.has(node.id)) push({ severity: "warning", code: "NO_INBOUND_EDGE", message: `Node "${node.id}" has no inbound edges`, ...(prefix ? { path: `nodes.${node.id}` } : {}) });
    }
  }

  for (const node of nodes) nodeStructure(node, `nodes.${node.id}`, `Node "${node.id}"`, prefix, out, lints, schemaChecked);

  if (lints) {
    push(...inputFieldDiagnostics(spec), ...outputFieldDiagnostics(spec), ...triggerDiagnostics(spec));
    if (prefix) push(...graphBodyLintDiagnostics(spec));
  }
}

/**
 * True when this config issue is a hook event or verb on a nested graph the
 * map walk will check itself. The schema path runs through that graph's
 * `runtime.hooks`, and the graph has `nodes`, so `graphStructure` reports it.
 */
function graphStructureChecksHook(value: unknown, issuePath: ReadonlyArray<PropertyKey>): boolean {
  const field = issuePath[issuePath.length - 1];
  if (field !== "on" && field !== "do") return false;
  const hooksAt = issuePath.lastIndexOf("hooks");
  if (hooksAt < 2 || issuePath[hooksAt - 1] !== "runtime") return false;
  let cursor = value;
  for (const segment of issuePath.slice(0, hooksAt - 1)) {
    if (!cursor || typeof cursor !== "object") return false;
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  if (!cursor || typeof cursor !== "object" || !Array.isArray((cursor as { nodes?: unknown }).nodes)) return false;
  const index = issuePath[hooksAt + 1];
  const hooks = (cursor as { runtime?: { hooks?: unknown } }).runtime?.hooks;
  if (typeof index !== "number" || !Array.isArray(hooks)) return false;
  const hook = hooks[index];
  // A missing or non-string field keeps the schema message, such as "Required".
  return isRecord(hook) && typeof hook[field] === "string";
}

/** Type registration and `with` shape for one node, then the graphs nested in it. */
function nodeStructure(node: NodeSpec, path: string, label: string, prefix: string, out: Diagnostic[], lints: boolean, schemaChecked: boolean): void {
  const push = (d: Diagnostic) => out.push(prefix ? nested(d, prefix) : d);
  const factory = registry.get(node.type);
  if (!factory) {
    push({ severity: "error", code: "UNKNOWN_NODE_TYPE", message: `${label} has unregistered type "${node.type}"`, path: `${path}.type` });
  } else {
    const configResult = factory.configSchema.safeParse(node.with ?? {});
    if (!configResult.success) {
      const issues = configResult.error.issues;
      // A string hook event or verb is reported by the walk. Any other schema
      // failure is the diagnostic for this body, so the nested lints do not run.
      const hookWalk = node.type === "map" && issues.every((issue) => graphStructureChecksHook(node.with, issue.path));
      for (const issue of issues) {
        if (hookWalk && graphStructureChecksHook(node.with, issue.path)) continue;
        const fieldPath = issue.path.join(".");
        push({
          severity: "error",
          code: "NODE_CONFIG_ERROR",
          message: fieldPath ? `${fieldPath}: ${issue.message}` : issue.message,
          path: fieldPath ? `${path}.with.${fieldPath}` : `${path}.with`,
        });
      }
      if (node.type === "map" && !hookWalk) return;
    }
  }
  if (node.type === "map") {
    const body = (node.with as { node?: unknown } | undefined)?.node;
    // A body without a type is already reported against the map's own `with`.
    if (isRecord(body) && typeof body.type === "string") {
      const id = typeof body.id === "string" ? body.id : undefined;
      // MapWithSchema has already parsed this body, including a subgraph spec.
      nodeStructure(body as unknown as NodeSpec, `${path}.with.node`, `Map "${node.id}" body${id ? ` "${id}"` : ""}`, prefix, out, lints, true);
    }
  }
  if (node.type === "subgraph" && isRecord(node.spec)) {
    if (Array.isArray(node.spec.nodes)) graphStructure(node.spec, `${prefix}${path}.spec.`, out, lints, schemaChecked);
    else if (!schemaChecked) push({ severity: "error", code: "SCHEMA_ERROR", path: `${path}.spec.nodes`, message: "Expected array" });
  }
}

function inputDefaultProblem(field: NonNullable<GraphSpec["inputs"]>[number]): string | undefined {
  if (field.default === undefined) return undefined;
  const problem = inputValueProblem(field, field.default);
  if (!problem) return undefined;
  return problem.replace(/^expected a (\w+)$/, "must be a $1");
}

const MAP_ITEM_ROOT: ReadonlySet<string> = new Set(["item"]);

/**
 * A map binds each item as `{{ <as> }}`. Bodies written for the earlier `{{ item.<as> }}` form
 * would render empty (an unknown root is null), so they are reported.
 */
export function mapItemBindingDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const node of recordNodes(spec.nodes)) {
    if (node.type !== "map" || !isRecord(node.with)) continue;
    const body = node.with["node"];
    if (!isRecord(body)) continue;
    const as = typeof node.with["as"] === "string" ? node.with["as"] : "item";
    const found: Array<{ at: string; text: string }> = [];
    for (const [key, value] of Object.entries(body)) {
      if (key === "spec") continue;
      withTemplates(value, key, found);
    }
    const old = (path: string): boolean => path === `item.${as}` || path.startsWith(`item.${as}.`) || path.startsWith(`item.${as}[`) || path.startsWith(`item[${JSON.stringify(as)}]`);
    for (const { at, text } of found) {
      for (const ref of templateRootRefs(text, MAP_ITEM_ROOT)) {
        if (!old(ref)) continue;
        diagnostics.push({
          severity: "error",
          code: "MAP_ITEM_REF_REMOVED",
          message: `Map "${node.id}" reads "${ref}" in ${at}, but the item is bound as {{ ${as} }} directly. Write ${ref.replace(/^item(\.|\[")${as}("\])?/, as)}.`,
          path: `nodes.${node.id}.with.node.${at}`,
        });
      }
    }
  }
  return diagnostics;
}

/** Graph `outputs`: unique keys, each naming a channel the graph has. */
export function outputFieldDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!Array.isArray(spec.outputs)) return diagnostics;
  const channels = knownChildChannels(spec);
  const seen = new Set<string>();
  for (const [index, field] of spec.outputs.entries()) {
    if (!field || typeof field.key !== "string") continue;
    const path = `outputs[${index}]`;
    if (seen.has(field.key)) {
      diagnostics.push({ severity: "error", code: "DUPLICATE_OUTPUT_KEY", path: `${path}.key`, message: `Output "${field.key}" is declared more than once` });
    }
    seen.add(field.key);
    if (!channels.has(field.key)) {
      diagnostics.push({ severity: "error", code: "OUTPUT_CHANNEL_UNKNOWN", path: `${path}.key`, message: `Output "${field.key}" is not a channel of this graph; declare it in state.channels or write it from a node` });
    }
  }
  return diagnostics;
}

/** Graph `inputs`: unique keys, options for each select, and defaults of the declared type. */
export function inputFieldDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const [index, field] of (Array.isArray(spec.inputs) ? spec.inputs : []).entries()) {
    const path = `inputs[${index}]`;
    if (!field || typeof field !== "object") {
      diagnostics.push({ severity: "error", code: "SCHEMA_ERROR", path, message: "Expected object" });
      continue;
    }
    if (seen.has(field.key)) {
      diagnostics.push({ severity: "error", code: "DUPLICATE_INPUT_KEY", path: `${path}.key`, message: `Input "${field.key}" is declared more than once` });
    }
    seen.add(field.key);
    if (field.type === "select" && !field.options?.length) {
      diagnostics.push({ severity: "error", code: "INPUT_OPTIONS_MISSING", path: `${path}.options`, message: `Input "${field.key}" has type select but no options; list the values it accepts` });
    }
    const problem = inputDefaultProblem(field);
    if (problem) {
      diagnostics.push({ severity: "error", code: "INPUT_DEFAULT_TYPE", path: `${path}.default`, message: `Input "${field.key}" (type ${field.type ?? "string"}): default ${problem}` });
    }
  }
  return diagnostics;
}

/** Graph `triggers`: unique ids, and a valid schedule and time zone on each cron trigger. */
export function triggerDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const [index, trigger] of (Array.isArray(spec.triggers) ? spec.triggers : []).entries()) {
    const path = `triggers[${index}]`;
    if (!trigger || typeof trigger !== "object") {
      diagnostics.push({ severity: "error", code: "SCHEMA_ERROR", path, message: "Expected object" });
      continue;
    }
    if (seen.has(trigger.id)) {
      diagnostics.push({ severity: "error", code: "DUPLICATE_TRIGGER_ID", path: `${path}.id`, message: `Trigger id "${trigger.id}" is used more than once; hosts use it to tell triggers apart` });
    }
    seen.add(trigger.id);
    if (trigger.type !== "cron") continue;
    if (typeof trigger.schedule !== "string") {
      diagnostics.push({ severity: "error", code: "SCHEMA_ERROR", path: `${path}.schedule`, message: trigger.schedule === undefined ? "Required" : "Expected string" });
      continue;
    }
    const problem = cronScheduleProblem(trigger.schedule);
    if (problem) {
      diagnostics.push({ severity: "error", code: "TRIGGER_CRON_INVALID", path: `${path}.schedule`, message: `Trigger "${trigger.id}" schedule "${trigger.schedule}": ${problem}` });
    }
    if (trigger.timezone !== undefined && !isKnownTimeZone(trigger.timezone)) {
      diagnostics.push({ severity: "error", code: "TRIGGER_TIMEZONE_INVALID", path: `${path}.timezone`, message: `Trigger "${trigger.id}" timezone "${trigger.timezone}" is not a known IANA time zone, such as "America/Denver" or "UTC"` });
    }
  }
  return diagnostics;
}

export function graphLintDiagnostics(spec: GraphSpec): Diagnostic[] {
  if (!lintableGraph(spec)) return [];
  return [
    ...defaultModelDiagnostics(spec),
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
    ...unevenFanInDiagnostics(spec),
    ...barrierEdgeDiagnostics(spec),
    ...unconditionalFanOutDiagnostics(spec),
    ...routerNoDefaultDiagnostics(spec),
    ...subgraphRefDiagnostics(spec),
    ...subgraphOutputMappingDiagnostics(spec),
    ...mapItemBindingDiagnostics(spec),
    ...placementDiagnostics(spec),
    ...placementAdjacentHopDiagnostics(spec),
    ...memoryLintDiagnostics(spec),
    ...contextLintDiagnostics(spec),
  ];
}
