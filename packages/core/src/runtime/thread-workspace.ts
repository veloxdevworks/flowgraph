import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { GraphSpec } from "@flowgraph/spec";
import { subgraphAliases } from "./graph-files.js";
import {
  REPLAY_WORKSPACE_CHANNEL,
  WORKSPACE_CHANNEL,
  WORKSPACE_NODES_CHANNEL,
} from "./state-annotation.js";

export function workspaceError(
  code: string,
  message: string,
): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`${code}: ${message}`), { code, retryable: false as const });
}

/** Canonicalize existing folders so a later symlink change cannot redirect a pinned run. */
export async function canonicalWorkspace(workspace: string): Promise<string> {
  const absolute = path.resolve(workspace);
  try {
    return await realpath(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return absolute;
  }
}

export function savedWorkspace(
  values: Record<string, unknown>,
  channel: string,
): string | undefined {
  // The first input checkpoint can precede START applying its input channels.
  const input = values["__start__"] as Record<string, unknown> | undefined;
  const value = values[channel] ?? input?.[channel];
  if (value == null) return undefined;
  if (typeof value !== "string" || !path.isAbsolute(value) || !value.trim()) {
    throw workspaceError(
      "THREAD_WORKSPACE_INVALID",
      `The saved ${channel} is invalid; inspect the thread before continuing.`,
    );
  }
  return path.resolve(value);
}

/** Effective execution root of a saved thread/branch, without executing or changing it. */
export async function readThreadWorkspace(
  checkpointer: Pick<BaseCheckpointSaver, "getTuple">,
  threadId: string,
  opts: { checkpointId?: string } = {},
): Promise<string | undefined> {
  const tuple = await checkpointer.getTuple({
    configurable: {
      thread_id: threadId,
      ...(opts.checkpointId ? { checkpoint_id: opts.checkpointId } : {}),
    },
  });
  if (!tuple) return undefined;
  const values = tuple.checkpoint.channel_values;
  return (
    savedWorkspace(values, REPLAY_WORKSPACE_CHANNEL) ?? savedWorkspace(values, WORKSPACE_CHANNEL)
  );
}

/** Detect explicit workspace edits that would move a pending task's journals. */
export async function workspaceDeclarations(
  spec: GraphSpec,
  graphDir: string,
  allowFiles = true,
): Promise<Record<string, string>> {
  const declarations: Record<string, string> = {};
  const visitGraph = async (
    graph: GraphSpec,
    dir: string,
    prefix: string,
    seen: Set<string>,
  ): Promise<void> => {
    const aliases = subgraphAliases(graph);
    const visit = async (node: Record<string, unknown>, at: string): Promise<void> => {
      if (typeof node.workspace === "string" && node.workspace.trim())
        declarations[at] = node.workspace;
      const child = node.spec as GraphSpec | undefined;
      if (node.type === "subgraph" && typeof child?.runtime?.workspace === "string")
        declarations[`${at}.runtime`] = child.runtime.workspace;
      if (node.type === "map") {
        const inner = (node.with as { node?: Record<string, unknown> } | undefined)?.node;
        if (inner && typeof inner === "object") await visit(inner, `${at}.map`);
      }
      if (node.type !== "subgraph") return;
      if (child) {
        await visitGraph(child, dir, `${at}.subgraph`, seen);
        return;
      }
      if (!allowFiles || typeof node.uses !== "string") return;
      const file = await canonicalWorkspace(path.resolve(dir, aliases[node.uses] ?? node.uses));
      declarations[`${at}.file`] = file;
      if (seen.has(file)) return;
      const { loadGraph } = await import("../loader.js");
      const loaded = await loadGraph(file);
      // Preserve normal load/validation diagnostics for a child that cannot load.
      if (!loaded.spec) return;
      if (typeof loaded.spec.runtime?.workspace === "string")
        declarations[`${at}.runtime`] = loaded.spec.runtime.workspace;
      await visitGraph(loaded.spec, path.dirname(file), `${at}.subgraph`, new Set([...seen, file]));
    };
    if (!Array.isArray(graph.nodes)) return;
    for (const node of graph.nodes) {
      if (!node || typeof node !== "object") continue;
      await visit(node as unknown as Record<string, unknown>, `${prefix}.${node.id}`);
    }
  };
  await visitGraph(spec, graphDir, "nodes", new Set());
  return Object.fromEntries(Object.entries(declarations).sort(([a], [b]) => a.localeCompare(b)));
}

export function assertWorkspaceDeclarations(
  values: Record<string, unknown>,
  declarations: Record<string, string>,
): void {
  const input = values["__start__"] as Record<string, unknown> | undefined;
  const saved = values[WORKSPACE_NODES_CHANNEL] ?? input?.[WORKSPACE_NODES_CHANNEL];
  if (saved != null && JSON.stringify(saved) !== JSON.stringify(declarations)) {
    throw workspaceError(
      "THREAD_WORKSPACE_MISMATCH",
      "A node or embedded graph workspace declaration changed. Restore the original declarations, or start a new thread.",
    );
  }
}
