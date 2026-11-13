/**
 * `flowgraph run --targets <file>` (ADR-0020 §4): load a topology, work out this host's labels, and
 * hand compile what it needs to place nodes on workers.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  bundleGraphForRemote,
  createHttpTransport,
  detectBuiltinLabels,
  hostLabels,
  parseTopology,
  runLabelChecks,
  type CompileOptions,
  type PlacementDecision,
  type Topology,
} from "@flowgraph/core";
import type { Diagnostic, GraphSpec } from "@flowgraph/spec";

/** Read a YAML or JSON topology file (JSON is YAML) and validate it. */
export async function loadTargetsFile(file: string, cwd: string): Promise<{ topology?: Topology; diagnostics: Diagnostic[] }> {
  const abs = path.resolve(cwd, file);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (err) {
    return { diagnostics: [{ severity: "error", code: "TOPOLOGY_UNREADABLE", message: `cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return { diagnostics: [{ severity: "error", code: "TOPOLOGY_INVALID", message: `${abs} is not valid YAML or JSON: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const { topology, diagnostics } = parseTopology(doc);
  return diagnostics.length > 0 ? { diagnostics } : { topology, diagnostics: [] };
}

/** Built-in labels plus the topology's `local.labels` whose checks pass. */
export async function localHostLabels(topology: Topology): Promise<string[]> {
  const builtin = await detectBuiltinLabels();
  const custom = topology.local?.labels ?? {};
  const checks = await runLabelChecks(custom);
  return hostLabels(builtin, custom, checks);
}

/**
 * Placed `uses:` subgraphs, loaded ahead of compile (the resolver's `loadChild` is synchronous) and
 * inlined as a worker would receive them.
 */
async function preloadPlacedChildren(
  spec: GraphSpec,
  opts: { graphDir: string; subgraphAliases: Record<string, string>; loadGraph: (ref: string, o: { cwd: string }) => Promise<{ spec?: GraphSpec | null | undefined }> },
): Promise<(ref: string) => GraphSpec | undefined> {
  const loaded = new Map<string, GraphSpec>();
  for (const node of spec.nodes ?? []) {
    if (node.runsOn === undefined || node.type !== "subgraph" || node.spec || !node.uses) continue;
    const ref = opts.subgraphAliases[node.uses] ?? node.uses;
    const child = (await opts.loadGraph(ref, { cwd: opts.graphDir })).spec;
    if (!child) continue; // the run reports the unloadable file when the node executes
    const bundled = await bundleGraphForRemote(child, { cwd: path.dirname(path.resolve(opts.graphDir, ref)) });
    loaded.set(node.uses, bundled.spec);
  }
  return (ref) => loaded.get(ref);
}

export async function placementCompileOptions(
  spec: GraphSpec,
  topology: Topology,
  ctx: { graphDir: string; subgraphAliases: Record<string, string>; loadGraph: Parameters<typeof preloadPlacedChildren>[1]["loadGraph"] },
): Promise<NonNullable<CompileOptions["placement"]>> {
  return {
    localLabels: await localHostLabels(topology),
    topology,
    transport: createHttpTransport(),
    loadChild: await preloadPlacedChildren(spec, { graphDir: ctx.graphDir, subgraphAliases: ctx.subgraphAliases, loadGraph: ctx.loadGraph }),
  };
}

/** `placement: <nodeId> → <target> (labels…)`, one per placed node. */
export function placementLines(decisions: PlacementDecision[]): string[] {
  return decisions.map((d) => `placement: ${d.nodeId} → ${d.target ?? d.kind} (${d.required.join(", ")})`);
}
