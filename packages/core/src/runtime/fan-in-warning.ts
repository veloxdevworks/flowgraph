/**
 * Compile-time heuristic: warn when parallel fan-out branches write the same
 * channel with a last-write-wins reducer (missing or explicit `lastWrite`).
 *
 * Only inspects immediate branch-entry nodes (the `to` targets of a fan-out
 * edge). Does not trace multi-hop paths before a join node.
 */

import type { GraphSpec, NodeSpec, Diagnostic } from "@veloxdevworks/flowgraph-spec";
import type { Logger } from "../context.js";

/** Channels a node writes via explicit `with.output` / `with.collect` projections. */
export function outputChannelsForNode(node: NodeSpec): string[] {
  const withBlock = (node.with ?? {}) as Record<string, unknown>;
  const channels = new Set<string>();

  const addFrom = (mapping: unknown) => {
    if (mapping == null || mapping === "none") return;
    if (typeof mapping !== "object" || Array.isArray(mapping)) return;
    const m = mapping as { to?: unknown; map?: unknown; none?: unknown };
    if (m.none === true) return;
    if (typeof m.to === "string" && m.to.trim()) channels.add(m.to.trim());
    if (m.map != null && typeof m.map === "object" && !Array.isArray(m.map)) {
      for (const ch of Object.keys(m.map as Record<string, unknown>)) {
        if (ch.trim()) channels.add(ch);
      }
    }
  };

  addFrom(withBlock["output"]);
  addFrom(withBlock["collect"]);

  return [...channels];
}

function isLastWriteReducer(reducer: string | undefined): boolean {
  return reducer === undefined || reducer === "lastWrite";
}

/**
 * Group fan-out siblings: edges whose `from` has multiple `to` targets, or
 * multiple edges share the same `from` with simple `to` edges.
 */
function fanOutGroups(spec: GraphSpec): Map<string, string[]> {
  const byFrom = new Map<string, Set<string>>();

  for (const edge of spec.edges) {
    if (!("to" in edge)) continue;
    const from = edge.from;
    const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
    let set = byFrom.get(from);
    if (!set) {
      set = new Set();
      byFrom.set(from, set);
    }
    for (const t of tos) set.add(t);
  }

  const groups = new Map<string, string[]>();
  for (const [from, targets] of byFrom) {
    if (targets.size >= 2) {
      groups.set(from, [...targets]);
    }
  }
  return groups;
}

function fanInLastWriteMessage(from: string, channel: string, writers: string[]): string {
  return (
    `Fan-out from "${from}" has ${writers.length} parallel branches writing channel "${channel}" ` +
    `with last-write-wins reducer; concurrent writes may lose data. ` +
    `Consider reducer: append, merge, or custom:<name>.`
  );
}

export function fanInLastWriteDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const channels = spec.state?.channels ?? {};
  const nodesById = new Map(spec.nodes.map((n) => [n.id, n]));
  const fanOut = fanOutGroups(spec);

  for (const [from, siblings] of fanOut) {
    const channelWriters = new Map<string, string[]>();

    for (const nodeId of siblings) {
      if (nodeId === "END") continue;
      const node = nodesById.get(nodeId);
      if (!node) continue;

      for (const ch of outputChannelsForNode(node)) {
        const writers = channelWriters.get(ch) ?? [];
        writers.push(nodeId);
        channelWriters.set(ch, writers);
      }
    }

    for (const [channel, writers] of channelWriters) {
      if (writers.length < 2) continue;
      const chDef = channels[channel];
      if (!chDef) continue;
      if (!isLastWriteReducer(chDef.reducer)) continue;

      diagnostics.push({
        severity: "warning",
        code: "FANIN_LAST_WRITE",
        message: fanInLastWriteMessage(from, channel, writers),
        path: `state.channels.${channel}`,
      });
    }
  }

  return diagnostics;
}

export function warnFanInLastWrite(spec: GraphSpec, logger: Logger): void {
  for (const d of fanInLastWriteDiagnostics(spec)) {
    logger.warn(d.message);
  }
}
