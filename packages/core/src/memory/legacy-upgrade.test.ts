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

const PG_URL = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

interface KeptOp {
  version: number;
  value: unknown;
  fingerprint: string | null;
}

interface Backing {
  memory: MemoryBackend;
  checkpointer: unknown;
  close(): Promise<void> | void;
  writes(): Promise<KeptOp[]>;
  replaceWrites(rows: Array<KeptOp & { opId: string }>): Promise<void>;
  items(): Promise<Record<string, unknown>>;
}

async function openSqlite(file: string): Promise<Backing> {
  const be = await openDb(file);
  return {
    memory: be.memory,
    checkpointer: be.checkpointer,
    close: () => be.close(),
    async writes() {
      return be.db
        .prepare(
          `SELECT version, value, fingerprint FROM fg_memory_ops WHERE fingerprint IS NULL OR fingerprint != 'nolegacy' ORDER BY applied_at, op_id`,
        )
        .all() as KeptOp[];
    },
    async replaceWrites(rows) {
      be.db.prepare(`DELETE FROM fg_memory_ops`).run();
      const ins = be.db.prepare(
        `INSERT INTO fg_memory_ops (op_id, version, value, applied_at, fingerprint) VALUES (?, ?, ?, ?, ?)`,
      );
      rows.forEach((r, i) => ins.run(r.opId, r.version, r.value, Date.now() + i, r.fingerprint));
    },
    async items() {
      const rows = be.db.prepare(`SELECT key, value FROM fg_memory_items`).all() as Array<{ key: string; value: string }>;
      return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
    },
  };
}

async function openPg(schema: string): Promise<Backing> {
  const href = new URL("../../../checkpoint-postgres/src/index.ts", import.meta.url).href;
  const mod = (await import(href)) as {
    openPostgresBackend(opts: { connectionString: string; schema: string }): Promise<{
      pool: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
      checkpointer: unknown;
      memory: MemoryBackend;
      close(): Promise<void>;
    }>;
  };
  const be = await mod.openPostgresBackend({ connectionString: PG_URL!, schema });
  const q = (sql: string, params?: unknown[]) => be.pool.query(sql, params);
  return {
    memory: be.memory,
    checkpointer: be.checkpointer,
    async close() {
      await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await be.close();
    },
    async writes() {
      const r = await q(
        `SELECT version, value, fingerprint FROM "${schema}".fg_memory_ops WHERE fingerprint IS NULL OR fingerprint != 'nolegacy' ORDER BY applied_at, op_id`,
      );
      return r.rows.map((row) => ({
        version: Number(row["version"]),
        value: row["value"],
        fingerprint: (row["fingerprint"] as string | null) ?? null,
      }));
    },
    async replaceWrites(rows) {
      await q(`DELETE FROM "${schema}".fg_memory_ops`);
      for (const [i, r] of rows.entries()) {
        await q(
          `INSERT INTO "${schema}".fg_memory_ops (op_id, version, value, applied_at, fingerprint) VALUES ($1, $2, $3::json, $4, $5)`,
          [r.opId, r.version, JSON.stringify(r.value ?? null), Date.now() + i, r.fingerprint],
        );
      }
    },
    async items() {
      const r = await q(`SELECT key, value FROM "${schema}".fg_memory_items`);
      return Object.fromEntries(r.rows.map((row) => [String(row["key"]), row["value"]]));
    },
  };
}

async function backing(kind: "sqlite" | "postgres", name: string): Promise<Backing> {
  if (kind === "sqlite") {
    const file = path.join(os.tmpdir(), `fg-legacy-${name}-${randomUUID()}.db`);
    files.push(file);
    return openSqlite(file);
  }
  return openPg(`up_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
}

function agentLegacy(row: Observed): MemoryOpSource {
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

let pair: "ab" | "xn" = "ab";
beforeAll(() => {
  registerFunction("upgradePairA", async (_i, ctx: NodeRunContext) => {
    const conf = ((ctx as { _lgConfig?: { configurable?: Record<string, unknown> } })._lgConfig?.configurable ?? {}) as Record<string, unknown>;
    const r = await ctx.memory!.increment("graph", "n", "");
    observed.push({
      nodeId: ctx.nodeId,
      checkpointNs: typeof conf["checkpoint_ns"] === "string" ? conf["checkpoint_ns"] : "",
      taskId: typeof conf["__pregel_task_id"] === "string" ? conf["__pregel_task_id"] : "",
      threadId: typeof conf["thread_id"] === "string" ? conf["thread_id"] : "",
      deduped: r.deduped,
    });
    return r.value;
  });
  registerFunction("upgradePairB", async (_i, ctx: NodeRunContext) => {
    ctx.interrupt({ reason: "approve B" });
    const conf = ((ctx as { _lgConfig?: { configurable?: Record<string, unknown> } })._lgConfig?.configurable ?? {}) as Record<string, unknown>;
    const note = (deduped: boolean) =>
      observed.push({
        nodeId: ctx.nodeId,
        checkpointNs: typeof conf["checkpoint_ns"] === "string" ? conf["checkpoint_ns"] : "",
        taskId: typeof conf["__pregel_task_id"] === "string" ? conf["__pregel_task_id"] : "",
        threadId: typeof conf["thread_id"] === "string" ? conf["thread_id"] : "",
        deduped,
      });
    if (pair === "xn") {
      const x = await ctx.memory!.increment("graph", "x", "");
      note(x.deduped);
    }
    const n = await ctx.memory!.increment("graph", "n", "");
    note(n.deduped);
    return n.value;
  });
});

function pairModel() {
  return createLangChainProvider(
    {
      invoke: async (msgs: Array<{ _getType?: () => string; constructor?: { name?: string } }>) => {
        const last = msgs[msgs.length - 1];
        const isTool = last && (last._getType?.() === "tool" || last.constructor?.name === "ToolMessage");
        if (isTool) return new AIMessage({ content: "done" });
        return new AIMessage({
          content: "",
          tool_calls: [
            { name: "a", id: "c0", args: {} },
            { name: "b", id: "c1", args: {} },
          ],
        });
      },
      bindTools() {
        return this;
      },
    } as never,
    { name: "legacy-pair-llm" },
  );
}

function pairSpec(shape: string): GraphSpec {
  const fn = (id: string, name: string) => ({ id, type: "function", when: "false", with: { fn: name } });
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: `legacy-pair-${shape}` },
    state: { channels: { out: { type: "object" } } },
    nodes: [
      {
        id: "o",
        type: "agent",
        provider: "legacy-pair-llm",
        with: { prompt: "go", tools: [{ node: "a" }, { node: "b" }], output: { to: "out" } },
      },
      fn("gate", "upgradePairA"),
      fn("a", "upgradePairA"),
      fn("b", "upgradePairB"),
    ],
    edges: [
      { from: "START", to: "o" },
      { from: "o", to: "END" },
      { from: "START", to: "gate" },
      { from: "gate", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "END" },
    ],
    runtime: { memory: {} },
  } as unknown as GraphSpec;
}

function childSpec(id: string) {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "child" },
    nodes: [{ id, type: "function", with: { fn: "legacyUpgradeBump" } }],
    edges: [
      { from: "START", to: id },
      { from: id, to: "END" },
    ],
  };
}

function multiSpec(kase: "sub2" | "subren", childId: string): GraphSpec {
  const nodes =
    kase === "sub2"
      ? [
          { id: "s1", type: "subgraph", spec: childSpec("bump") },
          { id: "s2", type: "subgraph", spec: childSpec("bump") },
        ]
      : [{ id: "s1", type: "subgraph", spec: childSpec(childId) }];
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: `legacy-${kase}` },
    state: { channels: {} },
    nodes,
    edges: [...nodes.map((n) => ({ from: "START", to: n.id })), ...nodes.map((n) => ({ from: n.id, to: "END" }))],
    runtime: { memory: {} },
  } as unknown as GraphSpec;
}

async function installOlder(store: Backing, sources: MemoryOpSource[], indexOf: (i: number) => number): Promise<void> {
  const ops = await store.writes();
  expect(ops).toHaveLength(sources.length);
  const rows = sources.map((source, i) => {
    const opId = memoryPositionalOpId(source, indexOf(i));
    expect(opId).toBeTruthy();
    return { ...ops[i]!, opId: opId! };
  });
  await store.replaceWrites(rows);
}

async function finish(compile: () => ReturnType<typeof compileGraph>, threadId: string) {
  let res = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
  for (let i = 0; i < 5 && res.status === "interrupted"; i++) {
    res = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
  }
  return res;
}

describe("older tool-call and subgraph numbering", () => {
  const kinds = ["sqlite", "postgres"] as const;
  for (const kind of kinds) {
    const test = kind === "postgres" && !PG_URL ? it.skip : it;

    test(`${kind}: two tool calls, the second writes x then n`, async () => {
      pair = "xn";
      observed.length = 0;
      const store = await backing(kind, "xn");
      try {
        const identity = { org: "acme", project: "web", user: "dev@acme.test" };
        const providers = [pairModel()];
        const compile = () =>
          compileGraph(pairSpec("xn"), {
            checkpointer: store.checkpointer as never,
            providers: providers as never,
            memory: { backend: store.memory, identity },
          });
        const threadId = "legacy-xn";
        const first = await (await compile()).run({ threadId, onInterrupt: "fail" });
        expect(first.status).toBe("interrupted");
        expect(observed.map((r) => r.deduped)).toEqual([false]);
        await installOlder(store, [agentLegacy(observed[0]!)], () => 0);
        observed.length = 0;
        const second = await finish(compile, threadId);
        expect(second.status).toBe("completed");
        expect(observed.map((r) => r.deduped)).toEqual([false, false]);
        expect(await store.items()).toMatchObject({ n: 2, x: 1 });
      } finally {
        await store.close();
      }
    });

    test(`${kind}: two tool calls, the second repeats n`, async () => {
      pair = "ab";
      observed.length = 0;
      const store = await backing(kind, "ab");
      try {
        const identity = { org: "acme", project: "web", user: "dev@acme.test" };
        const providers = [pairModel()];
        const compile = () =>
          compileGraph(pairSpec("ab"), {
            checkpointer: store.checkpointer as never,
            providers: providers as never,
            memory: { backend: store.memory, identity },
          });
        const threadId = "legacy-ab";
        const first = await (await compile()).run({ threadId, onInterrupt: "fail" });
        expect(first.status).toBe("interrupted");
        await installOlder(store, [agentLegacy(observed[0]!)], () => 0);
        observed.length = 0;
        const second = await finish(compile, threadId);
        expect(second.status).toBe("completed");
        expect(observed.map((r) => r.deduped)).toEqual([true]);
        expect(await store.items()).toMatchObject({ n: 1 });
        expect((await store.items()).x).toBeUndefined();
      } finally {
        await store.close();
      }
    });

    test(`${kind}: two subgraphs with the same child id`, async () => {
      observed.length = 0;
      const store = await backing(kind, "sub2");
      try {
        const identity = { org: "acme", project: "web", user: "dev@acme.test" };
        const compile = () =>
          compileGraph(multiSpec("sub2", "bump"), {
            checkpointer: store.checkpointer as never,
            memory: { backend: store.memory, identity },
          });
        const threadId = "legacy-sub2";
        const first = await (await compile()).run({ threadId, onInterrupt: "fail" });
        expect(first.status).toBe("interrupted");
        expect(observed).toHaveLength(2);
        await installOlder(
          store,
          observed.map((row) => ({
            threadId: row.threadId,
            checkpointNs: row.checkpointNs,
            taskId: row.taskId,
            nodeId: row.nodeId,
          })),
          () => 0,
        );
        observed.length = 0;
        const second = await finish(compile, threadId);
        expect(second.status).toBe("completed");
        expect(observed.every((r) => r.deduped)).toBe(true);
        expect(await store.items()).toMatchObject({ n: 2 });
      } finally {
        await store.close();
      }
    });

    test(`${kind}: a renamed subgraph child applies again`, async () => {
      observed.length = 0;
      const store = await backing(kind, "subren");
      try {
        const identity = { org: "acme", project: "web", user: "dev@acme.test" };
        const compile = (childId: string) =>
          compileGraph(multiSpec("subren", childId), {
            checkpointer: store.checkpointer as never,
            memory: { backend: store.memory, identity },
          });
        const threadId = "legacy-subren";
        const first = await (await compile("bump")).run({ threadId, onInterrupt: "fail" });
        expect(first.status).toBe("interrupted");
        expect(observed).toHaveLength(1);
        await installOlder(
          store,
          [{ threadId: observed[0]!.threadId, checkpointNs: observed[0]!.checkpointNs, taskId: observed[0]!.taskId, nodeId: observed[0]!.nodeId }],
          () => 0,
        );
        observed.length = 0;
        let res = await (await compile("bump2")).resume({ threadId, resume: true, onInterrupt: "fail" });
        for (let i = 0; i < 5 && res.status === "interrupted"; i++) {
          res = await (await compile("bump2")).resume({ threadId, resume: true, onInterrupt: "fail" });
        }
        // The resumed graph keeps the first write. The new child id is not the
        // node that was interrupted, so that write is not applied again.
        expect(res.status).toBe("completed");
        expect(observed).toEqual([]);
        expect(await store.items()).toMatchObject({ n: 1 });
      } finally {
        await store.close();
      }
    });
  }
});
