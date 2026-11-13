/**
 * Compile-time placement plan (ADR-0020 §5, §7): which top-level nodes run in-process and which are
 * wrapped in a remote executor. Graphs without `runsOn` get no plan and pay nothing.
 */

import type { Diagnostic, GraphSpec, NodeSpec } from "@flowgraph/spec";
import { UNPLACEABLE_TYPES, graphHasPlacement, placementDiagnostics, unplaceableMessage } from "../runtime/validate-graph.js";
import { detectBuiltinLabelsSync } from "./labels.js";
import { PlacementUnsatisfiedError } from "./errors.js";
import { createRemoteNodeExecutor, type RemoteNodeExecutor } from "./remote.js";
import { placementUnsatisfiedMessage, resolvePlacements, type PlacementDecision } from "./resolve.js";
import type { Topology } from "./topology.js";
import type { WorkerTransport } from "./transport.js";

export interface CompilePlacementOptions {
  /** Labels this host advertises. Default: `detectBuiltinLabelsSync()`. */
  localLabels?: string[];
  /** Targets a placed node may run on. With neither this nor `transport`, only the local host is used. */
  topology?: Topology;
  transport?: WorkerTransport;
  /** Resolve `uses:` subgraph refs for requirement inference and worker preflight. */
  loadChild?: (ref: string) => GraphSpec | undefined;
}

export interface PlacementPlan {
  decisions: PlacementDecision[];
  /** Executors for nodes decided `remote`, by node id. */
  remote: Map<string, RemoteNodeExecutor>;
}


export async function planPlacements(spec: GraphSpec, opts: CompilePlacementOptions | undefined): Promise<PlacementPlan | undefined> {
  // Same rule as `flowgraph validate`, for callers that compile without loadGraph: runsOn below the top
  // level (inline subgraph or map inner) is never resolved, so refuse it instead of running the node here.
  if (graphHasPlacement(spec)) {
    const structural = placementDiagnostics(spec).filter(
      (d) => d.code === "PLACEMENT_NOT_TOP_LEVEL" || d.code === "PLACEMENT_NESTED",
    );
    if (structural.length) throw new PlacementUnsatisfiedError(structural.map((d) => d.message).join("\n"), [], structural);
  }
  if (!spec.nodes?.some((n) => n.runsOn !== undefined)) return undefined;
  // Same rule as `flowgraph validate`: map and router cannot be placed at all, even if they would resolve local.
  for (const n of spec.nodes) {
    if (n.runsOn !== undefined && UNPLACEABLE_TYPES.has(n.type)) {
      const d: Diagnostic = { severity: "error", code: "PLACEMENT_NOT_SUPPORTED", message: unplaceableMessage(n.id, n.type), path: `nodes.${n.id}.runsOn` };
      throw new PlacementUnsatisfiedError(d.message, [], [d]);
    }
  }
  const localLabels = opts?.localLabels ?? detectBuiltinLabelsSync();
  const connected = opts?.topology !== undefined || opts?.transport !== undefined;
  const { decisions, diagnostics } = await resolvePlacements(spec, {
    localLabels,
    ...(connected && opts?.topology ? { topology: opts.topology } : {}),
    ...(connected && opts?.transport ? { transport: opts.transport } : {}),
    ...(opts?.loadChild ? { loadChild: opts.loadChild } : {}),
  });

  const errors: Diagnostic[] = [...diagnostics];
  for (const d of decisions) {
    if (d.kind === "queued") {
      errors.push({
        severity: "error",
        code: "PLACEMENT_UNSATISFIED",
        message:
          `PLACEMENT_UNSATISFIED: node "${d.nodeId}" sets runsOn.wait, which queues it until a matching worker appears. ` +
          `\`wait\` arrives in phase 2 of ADR-0020; remove it or make a matching worker available now.\n` +
          placementUnsatisfiedMessage(d.nodeId, d.required, d.candidates).split("\n").slice(1).join("\n"),
        path: `nodes.${d.nodeId}.runsOn.wait`,
      });
    }
  }
  if (errors.length > 0) {
    throw new PlacementUnsatisfiedError(errors.map((e) => e.message).join("\n"), decisions, errors);
  }

  const remote = new Map<string, RemoteNodeExecutor>();
  for (const d of decisions) {
    if (d.kind !== "remote") continue;
    const node = spec.nodes.find((n) => n.id === d.nodeId) as NodeSpec;
    remote.set(
      d.nodeId,
      createRemoteNodeExecutor({
        node,
        decision: d,
        topology: opts?.topology,
        transport: opts!.transport!,
        localLabels,
        loadChild: opts?.loadChild,
      }),
    );
  }
  return { decisions, remote };
}
