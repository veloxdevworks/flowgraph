/**
 * Partial graph bundler for remote portability.
 *
 * Inlines filesystem-backed subgraphs (`uses` → `spec`) and AGENT.md refs
 * (`with.agent` → `with.system`). Collects hard blockers for refs that cannot
 * be made portable (skills, custom imports, stdio MCP, shell nodes).
 */

import * as path from "node:path";
import type { GraphSpec, NodeSpec } from "@veloxdevworks/flowgraph-spec";
import { loadGraph } from "../loader.js";
import { resolveAgentPath } from "../agent-resolver.js";
import { loadAgentDef } from "../agents/loader.js";

export interface BundleResult {
  spec: GraphSpec;
  /** Human-readable notes, e.g. `subgraph "review" → inlined 4 nodes`. */
  inlined: string[];
  /** Human-readable reasons the graph still can't run remotely. */
  blockers: string[];
}

export interface BundleGraphOptions {
  cwd: string;
}

function cloneSpec(spec: GraphSpec): GraphSpec {
  return structuredClone(spec) as GraphSpec;
}

function subgraphAliases(spec: GraphSpec): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const imp of spec.imports ?? []) {
    if ("subgraph" in imp) {
      aliases[imp.as ?? imp.subgraph] = imp.subgraph;
    }
  }
  return aliases;
}

function agentAliases(spec: GraphSpec): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const imp of spec.imports ?? []) {
    if ("agent" in imp) {
      aliases[imp.as ?? imp.agent] = imp.agent;
    }
  }
  return aliases;
}

function isInlineGraphSpec(value: unknown): value is GraphSpec {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

function prefixNotes(prefix: string, notes: string[]): string[] {
  return notes.map((n) => `${prefix}${n}`);
}

async function bundleNodeRef(
  node: NodeSpec,
  opts: {
    cwd: string;
    subgraphAliases: Record<string, string>;
    agentAliases: Record<string, string>;
    pathPrefix: string;
  },
): Promise<{ node: NodeSpec; inlined: string[]; blockers: string[] }> {
  const inlined: string[] = [];
  const blockers: string[] = [];
  let next = node;

  if (node.type === "shell") {
    blockers.push(
      `node "${opts.pathPrefix}${node.id}" (type shell) requires host binaries/PATH and cannot run on a remote server`,
    );
  }

  if (node.type === "skill") {
    const uses = typeof node.uses === "string" ? node.uses : "(unknown)";
    blockers.push(
      `node "${opts.pathPrefix}${node.id}" (type skill, uses: ${uses}) cannot be inlined — skill handlers/commands stay local-only`,
    );
  }

  if (node.type === "subgraph") {
    if (isInlineGraphSpec(node.spec)) {
      // Already bundled — recurse into the inline child for further portability work.
      const childBundled = await bundleGraphForRemote(node.spec, { cwd: opts.cwd });
      next = { ...node, uses: undefined, spec: childBundled.spec };
      inlined.push(...prefixNotes(`${opts.pathPrefix}${node.id}/`, childBundled.inlined));
      blockers.push(...prefixNotes(`${opts.pathPrefix}${node.id}/`, childBundled.blockers));
    } else if (typeof node.uses === "string" && node.uses.trim()) {
      const ref = opts.subgraphAliases[node.uses] ?? node.uses;
      const resolvedPath = path.resolve(opts.cwd, ref);
      const childCwd = path.dirname(resolvedPath);
      const loaded = await loadGraph(ref, { cwd: opts.cwd });
      if (!loaded.spec) {
        blockers.push(
          `node "${opts.pathPrefix}${node.id}" (subgraph uses: ${node.uses}): could not load "${ref}" — ${loaded.diagnostics.map((d) => d.message).join("; ")}`,
        );
      } else {
        const childBundled = await bundleGraphForRemote(loaded.spec, { cwd: childCwd });
        const nodeCount = childBundled.spec.nodes.length;
        inlined.push(
          `subgraph "${opts.pathPrefix}${node.id}" (uses: ${node.uses}) → inlined ${nodeCount} node${nodeCount === 1 ? "" : "s"}`,
        );
        inlined.push(...prefixNotes(`${opts.pathPrefix}${node.id}/`, childBundled.inlined));
        blockers.push(...prefixNotes(`${opts.pathPrefix}${node.id}/`, childBundled.blockers));
        const { uses: _drop, ...rest } = node;
        next = { ...rest, spec: childBundled.spec };
      }
    }
  }

  if (node.type === "agent") {
    const withBlock = { ...((node.with ?? {}) as Record<string, unknown>) };
    const agentRef = withBlock["agent"];
    if (typeof agentRef === "string" && agentRef.trim()) {
      try {
        const agentDir = await resolveAgentPath(agentRef, {
          cwd: opts.cwd,
          aliases: opts.agentAliases,
        });
        const { agent, diagnostics } = await loadAgentDef(agentDir);
        if (!agent) {
          blockers.push(
            `node "${opts.pathPrefix}${node.id}" (with.agent: ${agentRef}): ${diagnostics.map((d) => d.message).join("; ") || "failed to load AGENT.md"}`,
          );
        } else {
          const existingSystem =
            typeof withBlock["system"] === "string" ? withBlock["system"] : "";
          withBlock["system"] = existingSystem
            ? `${agent.body}\n\n${existingSystem}`
            : agent.body;
          delete withBlock["agent"];
          next = { ...next, with: withBlock };
          inlined.push(
            `agent "${opts.pathPrefix}${node.id}" (with.agent: ${agentRef}) → inlined as with.system`,
          );
        }
      } catch (err) {
        blockers.push(
          `node "${opts.pathPrefix}${node.id}" (with.agent: ${agentRef}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Map nodes may embed a nested subgraph/agent under with.node.
  if (node.type === "map") {
    const withBlock = { ...((next.with ?? {}) as Record<string, unknown>) };
    const inner = withBlock["node"];
    if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
      const innerNode = inner as NodeSpec;
      if (typeof innerNode.type === "string" && typeof innerNode.id === "string") {
        const nested = await bundleNodeRef(innerNode, {
          ...opts,
          pathPrefix: `${opts.pathPrefix}${node.id}.map.`,
        });
        withBlock["node"] = nested.node;
        next = { ...next, with: withBlock };
        inlined.push(...nested.inlined);
        blockers.push(...nested.blockers);
      }
    }
  }

  return { node: next, inlined, blockers };
}

/**
 * Produce a remote-portable GraphSpec by inlining subgraphs and AGENT.md refs.
 * Non-portable features are reported in `blockers` (the returned spec may still
 * contain them — callers should refuse to upload when blockers are non-empty).
 */
export async function bundleGraphForRemote(
  spec: GraphSpec,
  opts: BundleGraphOptions,
): Promise<BundleResult> {
  const cwd = opts.cwd;
  const working = cloneSpec(spec);
  const inlined: string[] = [];
  const blockers: string[] = [];

  const sgAliases = subgraphAliases(working);
  const agAliases = agentAliases(working);

  // Custom module imports are never portable (server strips imports and refuses client code).
  for (const imp of working.imports ?? []) {
    if ("nodes" in imp) {
      blockers.push(
        `imports.nodes "${imp.nodes}" cannot run remotely — custom node modules are stripped by the server`,
      );
    } else if ("providers" in imp) {
      blockers.push(
        `imports.providers "${imp.providers}" cannot run remotely — custom provider modules are stripped by the server`,
      );
    } else if ("reducers" in imp) {
      blockers.push(
        `imports.reducers "${imp.reducers}" cannot run remotely — custom reducer modules are stripped by the server`,
      );
    } else if ("skill" in imp) {
      blockers.push(
        `imports.skill "${imp.skill}" cannot be inlined — skills stay local-only`,
      );
    }
  }

  // stdio MCP servers require spawning a local process.
  for (const [name, server] of Object.entries(working.mcpServers ?? {})) {
    if (server && typeof server === "object" && "transport" in server && server.transport === "stdio") {
      blockers.push(
        `mcpServers.${name} uses transport stdio and cannot run on a remote server (use HTTP MCP or configure the server host-side)`,
      );
    }
  }

  const nextNodes: NodeSpec[] = [];
  for (const node of working.nodes) {
    const result = await bundleNodeRef(node, {
      cwd,
      subgraphAliases: sgAliases,
      agentAliases: agAliases,
      pathPrefix: "",
    });
    nextNodes.push(result.node);
    inlined.push(...result.inlined);
    blockers.push(...result.blockers);
  }
  working.nodes = nextNodes;

  // Drop subgraph/agent import aliases that are no longer referenced.
  if (working.imports && working.imports.length > 0) {
    const stillNeededSubgraphs = new Set<string>();
    const stillNeededAgents = new Set<string>();
    const walk = (nodes: NodeSpec[]) => {
      for (const n of nodes) {
        if (n.type === "subgraph" && typeof n.uses === "string" && n.uses.trim()) {
          stillNeededSubgraphs.add(n.uses);
          const resolved = sgAliases[n.uses];
          if (resolved) stillNeededSubgraphs.add(resolved);
        }
        if (n.type === "agent") {
          const agentRef = (n.with as { agent?: unknown } | undefined)?.agent;
          if (typeof agentRef === "string" && agentRef.trim()) {
            stillNeededAgents.add(agentRef);
            const resolved = agAliases[agentRef];
            if (resolved) stillNeededAgents.add(resolved);
          }
        }
        if (n.type === "map") {
          const inner = (n.with as { node?: unknown } | undefined)?.node;
          if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
            walk([inner as NodeSpec]);
          }
        }
        if (isInlineGraphSpec(n.spec)) {
          walk(n.spec.nodes);
        }
      }
    };
    walk(working.nodes);

    working.imports = working.imports.filter((imp) => {
      if ("subgraph" in imp) {
        const key = imp.as ?? imp.subgraph;
        return stillNeededSubgraphs.has(key) || stillNeededSubgraphs.has(imp.subgraph);
      }
      if ("agent" in imp) {
        const key = imp.as ?? imp.agent;
        return stillNeededAgents.has(key) || stillNeededAgents.has(imp.agent);
      }
      // Leave other import kinds (skill/nodes/providers/reducers) — they are blockers.
      return true;
    });
    if (working.imports.length === 0) {
      delete working.imports;
    }
  }

  return { spec: working, inlined, blockers };
}
