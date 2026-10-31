import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import type { NodeRunContext } from "../context.js";
import { compileGraph } from "../compiler.js";
import { createLangChainProvider } from "../index.js";
import { registerFunction } from "../nodes/function.js";
import "../nodes/index.js";
import { memoryPositionalOpId, type MemoryOpSource } from "./handle.js";
import type { MemoryBackend } from "./types.js";

/** Sqlite lives in another package; load it at runtime so this file stays inside core's typecheck. */
async function openDb(dbPath: string): Promise<{
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown } };
  checkpointer: unknown;
  memory: MemoryBackend;
  close(): void;
}> {
  const href = new URL("../../../checkpoint-sqlite/src/index.ts", import.meta.url).href;
  const mod = (await import(href)) as {
    openSqliteBackend(path: string): Promise<{
      db: { prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown } };
      checkpointer: unknown;
      memory: MemoryBackend;
      close(): void;
    }>;
  };
  return mod.openSqliteBackend(dbPath);
}

/**
 * What one bump observed. Older builds keyed positional ids from these, except
 * a tool call, which was stored on the calling agent's namespace and node id.
 */
interface Observed {
  nodeId: string;
  checkpointNs: string;
  taskId: string;
  threadId: string;
  deduped: boolean;
}

const observed: Observed[] = [];
const files: string[] = [];

beforeAll(() => {
  registerFunction("legacyUpgradeBump", async (_i, ctx: NodeRunContext) => {
    const conf = ((ctx as { _lgConfig?: { configurable?: Record<string, unknown> } })._lgConfig?.configurable ??
      {}) as Record<string, unknown>;
    const r = await ctx.memory!.increment("graph", "n", "");
    observed.push({
      nodeId: ctx.nodeId,
      checkpointNs: typeof conf["checkpoint_ns"] === "string" ? conf["checkpoint_ns"] : "",
      taskId: typeof conf["__pregel_task_id"] === "string" ? conf["__pregel_task_id"] : "",
      threadId: typeof conf["thread_id"] === "string" ? conf["thread_id"] : "",
      deduped: r.deduped,
    });
    ctx.interrupt({ reason: "hold" });
    return r.value;
  });
});

afterEach(async () => {
  for (const f of files.splice(0)) await fs.rm(f, { force: true });
});

function model() {
  return createLangChainProvider(
    {
      invoke: async (msgs: Array<{ _getType?: () => string; constructor?: { name?: string } }>) => {
        const last = msgs[msgs.length - 1];
        const isTool = last && (last._getType?.() === "tool" || last.constructor?.name === "ToolMessage");
        if (isTool) return new AIMessage({ content: "done" });
        return new AIMessage({ content: "", tool_calls: [{ name: "bump", id: "c0", args: {} }] });
      },
      bindTools() {
        return this;
      },
    } as never,
    { name: "legacy-upgrade-llm" },
  );
}

const fnNode = (id: string) => ({ id, type: "function", with: { fn: "legacyUpgradeBump" } });
const child = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "child" },
  nodes: [fnNode("bump")],
  edges: [
    { from: "START", to: "bump" },
    { from: "bump", to: "END" },
  ],
};

function specFor(kase: string): GraphSpec {
  const graphs: Record<string, { nodes: unknown[]; edges: unknown[]; state?: unknown }> = {
    top: {
      nodes: [fnNode("bump")],
      edges: [
        { from: "START", to: "bump" },
        { from: "bump", to: "END" },
      ],
    },
    sub: {
      nodes: [{ id: "sg", type: "subgraph", spec: child }],
      edges: [
        { from: "START", to: "sg" },
        { from: "sg", to: "END" },
      ],
    },
    map: {
      state: { channels: { items: { type: "array" }, got: { type: "array" } } },
      nodes: [
        {
          id: "m",
          type: "map",
          with: {
            over: "{{ state.items }}",
            node: { type: "function", with: { fn: "legacyUpgradeBump" } },
            collect: { to: "got" },
          },
        },
      ],
      edges: [
        { from: "START", to: "m" },
        { from: "m", to: "END" },
      ],
    },
    tool: {
      state: { channels: { out: { type: "object" } } },
      nodes: [
        { id: "gate", type: "function", when: "false", with: { fn: "legacyUpgradeBump" } },
        {
          id: "o",
          type: "agent",
          provider: "legacy-upgrade-llm",
          with: { prompt: "go", tools: [{ node: "bump" }], output: { to: "out" } },
        },
        { id: "bump", type: "function", when: "false", with: { fn: "legacyUpgradeBump" } },
      ],
      edges: [
        { from: "START", to: "o" },
        { from: "o", to: "END" },
        { from: "START", to: "gate" },
        { from: "gate", to: "bump" },
        { from: "bump", to: "END" },
      ],
    },
  };
  const g = graphs[kase]!;
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: `legacy-up-${kase}` },
    state: g.state ?? { channels: {} },
    nodes: g.nodes,
    edges: g.edges,
    runtime: { memory: {} },
  } as unknown as GraphSpec;
}

/** Positional id an older build stored for this write. */
function olderOpSource(kase: string, row: Observed): MemoryOpSource {
  if (kase === "tool") {
    const cut = row.checkpointNs.lastIndexOf("|");
    const tail = cut === -1 ? row.checkpointNs : row.checkpointNs.slice(cut + 1);
    const parent = cut === -1 ? "" : row.checkpointNs.slice(0, cut);
    return {
      threadId: row.threadId,
      checkpointNs: /\.tool\d+$/.test(tail) ? parent : row.checkpointNs,
      taskId: row.taskId,
      nodeId: "o",
    };
  }
  return { threadId: row.threadId, checkpointNs: row.checkpointNs, taskId: row.taskId, nodeId: row.nodeId };
}

describe("memory writes from an older id scheme", () => {
  for (const kase of ["top", "sub", "map", "tool"] as const) {
    it(`${kase}: a resume applies the older write once`, async () => {
      observed.length = 0;
      const dbPath = path.join(os.tmpdir(), `fg-legacy-up-${kase}-${randomUUID()}.db`);
      files.push(dbPath);
      const be = await openDb(dbPath);
      try {
        const identity = { org: "acme", project: "web", user: "dev@acme.test" };
        const providers = kase === "tool" ? [model()] : [];
        const compile = () =>
          compileGraph(specFor(kase), {
            checkpointer: be.checkpointer as never,
            providers: providers as never,
            memory: { backend: be.memory, identity },
          });
        const threadId = `legacy-up-${kase}`;
        const input = kase === "map" ? { items: ["a"] } : {};
        const first = await (await compile()).run({ threadId, input, onInterrupt: "fail" });
        expect(first.status).toBe("interrupted");
        expect(observed).toHaveLength(1);
        expect(observed[0]!.deduped).toBe(false);
        const firstObs = observed[0]!;

        const source = olderOpSource(kase, firstObs);
        const positional = memoryPositionalOpId(source, 0);
        expect(positional).toBeTruthy();
        const ops = be.db
          .prepare(`SELECT op_id, version, value, fingerprint FROM fg_memory_ops WHERE fingerprint IS NULL OR fingerprint != 'nolegacy'`)
          .all() as Array<{ op_id: string; version: number; value: string | null; fingerprint: string | null }>;
        expect(ops).toHaveLength(1);
        // The row this build just wrote is not the older positional id.
        expect(ops[0]!.op_id).not.toBe(positional);
        const kept = ops[0]!;
        be.db.prepare(`DELETE FROM fg_memory_ops`).run();
        be.db
          .prepare(`INSERT INTO fg_memory_ops (op_id, version, value, applied_at, fingerprint) VALUES (?, ?, ?, ?, ?)`)
          .run(positional, kept.version, kept.value, Date.now(), kept.fingerprint);

        observed.length = 0;
        const second = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
        expect(second.status).toBe("completed");
        expect(observed).toEqual([{ ...firstObs, deduped: true }]);
        const stored = be.db.prepare(`SELECT value FROM fg_memory_items WHERE key = 'n'`).all() as Array<{ value: string }>;
        expect(stored.map((r) => JSON.parse(r.value))).toEqual([1]);
      } finally {
        be.close();
      }
    });
  }
});
