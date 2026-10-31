import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph, createScopedMemory, defaultMemoryPolicy, registerFunction, type GraphSpec } from "@flowgraph/core";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createSqliteCheckpointer, FG_CHECKPOINT_TYPE, openSqliteBackend, sqliteCheckpointStats, type SqliteBackend } from "./index.js";

registerFunction("sqlRet", () => "done");
registerFunction("sqlBump", (input) => {
  const raw = (input as { n?: unknown } | undefined)?.n;
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(n) ? n + 1 : 1;
});
registerFunction("sqlFan", () => ({}));
const sqlSideHits: string[] = [];
registerFunction("sqlSide", () => {
  sqlSideHits.push("S");
  return "S";
});

const tmpFiles: string[] = [];
const open: SqliteBackend[] = [];
afterEach(() => {
  for (const backend of open.splice(0)) backend.close();
  for (const file of tmpFiles.splice(0)) fs.rmSync(file, { force: true });
});

function tmpDb(): string {
  const file = path.join(os.tmpdir(), `fg-ret-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tmpFiles.push(file);
  return file;
}

function parallelSpec(warm: number): GraphSpec {
  return {
    metadata: { name: "sqlite-parallel-side" },
    state: { channels: { n: { type: "number" }, sideOut: { type: "string" }, gate: { type: "object" } } },
    nodes: [
      { id: "bump", type: "function", with: { fn: "sqlBump", input: { n: "{{ state.n }}" }, output: { to: "n" } } },
      { id: "fan", type: "function", with: { fn: "sqlFan" } },
      { id: "effect", type: "function", with: { fn: "sqlSide", output: { to: "sideOut" } } },
      { id: "ask", type: "hitl", with: { mode: "approve", message: "approve the side effect?", output: { to: "gate" } } },
    ],
    edges: [
      { from: "START", to: "bump" },
      {
        from: "bump",
        branch: [
          { when: `{{ state.n < ${warm} }}`, to: "bump" },
          { default: true, to: "fan" },
        ],
      },
      { from: "fan", to: ["effect", "ask"] },
      { from: "effect", to: "END" },
      { from: "ask", to: "END" },
    ],
  } as unknown as GraphSpec;
}

function mapSpec(warm: number): GraphSpec {
  const bump = warm > 0
    ? [{ id: "bump", type: "function", with: { fn: "sqlBump", input: { n: "{{ state.n }}" }, output: { to: "n" } } }]
    : [];
  return {
    metadata: { name: "sqlite-map-items" },
    state: { channels: { n: { type: "number" }, numbers: { type: "array" }, out: { type: "array" } } },
    nodes: [
      ...bump,
      {
        id: "map-items",
        type: "map",
        with: {
          over: "{{ state.numbers }}",
          as: "n",
          concurrency: 2,
          node: {
            type: "hitl",
            with: { mode: "approve", message: "Approve {{ item.n }}", output: { to: "itemResult" } },
          },
          collect: { to: "out" },
        },
      },
    ],
    edges: warm > 0
      ? [
          { from: "START", to: "bump" },
          {
            from: "bump",
            branch: [
              { when: `{{ state.n < ${warm} }}`, to: "bump" },
              { default: true, to: "map-items" },
            ],
          },
          { from: "map-items", to: "END" },
        ]
      : [
          { from: "START", to: "map-items" },
          { from: "map-items", to: "END" },
        ],
  } as unknown as GraphSpec;
}

async function drive(
  checkpointer: ReturnType<typeof createSqliteCheckpointer>,
  spec: GraphSpec,
  input: Record<string, unknown>,
) {
  sqlSideHits.length = 0;
  const compiled = await compileGraph(spec, { checkpointer });
  const threadId = `live-${Math.random().toString(36).slice(2)}`;
  let result = await compiled.run({ threadId, input, onInterrupt: "fail" });
  let resumes = 0;
  while (result.status === "interrupted" && resumes < 8) {
    resumes += 1;
    result = await compiled.resume({ threadId, resume: { approved: true }, onInterrupt: "fail" });
  }
  return {
    status: result.status,
    resumes,
    hits: [...sqlSideHits],
    out: result.state["out"],
    gate: result.state["gate"],
    side: result.state["sideOut"],
  };
}

const interruptSpec = {
  metadata: { name: "sqlite-retain" },
  state: { channels: { tag: { type: "string" } } },
  nodes: [
    { id: "gate", type: "wait", with: { signal: "go" } },
    { id: "a", type: "function", with: { fn: "sqlRet", output: { to: "tag" } } },
    { id: "b", type: "function", with: { fn: "sqlRet", output: { to: "tag" } } },
    { id: "c", type: "function", with: { fn: "sqlRet", output: { to: "tag" } } },
    { id: "d", type: "function", with: { fn: "sqlRet", output: { to: "tag" } } },
  ],
  edges: [
    { from: "START", to: "gate" },
    { from: "gate", to: "a" },
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
    { from: "d", to: "END" },
  ],
} as unknown as GraphSpec;

describe("sqlite checkpoint retention", () => {
  it("resumes a paused thread after pruning and keeps the interrupt checkpoint", async () => {
    const dbPath = tmpDb();
    const retention = { maxCheckpoints: 2, maxInterruptPoints: 4, finishedTtl: null, maxFinishedThreads: null };
    const threadId = "sqlite-resume";
    const first = createSqliteCheckpointer({ path: dbPath, retention });
    const compiled = await compileGraph(interruptSpec, { checkpointer: first });
    const paused = await compiled.run({ threadId, onInterrupt: "fail" });
    expect(paused.status).toBe("interrupted");
    const interruptId = (await compiled.getState(threadId))?.checkpointId;
    expect(interruptId).toBeTruthy();

    const resumed = await compiled.resume({ threadId, resume: { go: true }, onInterrupt: "fail" });
    expect(resumed.status).toBe("completed");
    expect(resumed.state["tag"]).toBe("done");
    const history = await compiled.getStateHistory(threadId);
    expect(history.some((item) => item.checkpointId === interruptId)).toBe(true);
    expect(history.length).toBeLessThanOrEqual(6);
    (first as unknown as { db: { close(): void } }).db.close();

    const second = createSqliteCheckpointer({ path: dbPath, retention });
    const recompiled = await compileGraph(interruptSpec, { checkpointer: second });
    const again = await recompiled.resumeFrom({
      threadId,
      checkpointId: interruptId!,
      resume: { go: true },
      onInterrupt: "fail",
    });
    expect(again.status).toBe("completed");
    expect(again.state["tag"]).toBe("done");
    (second as unknown as { db: { close(): void } }).db.close();
  });

  it("deletes finished threads and leaves fg_memory rows in place", async () => {
    const dbPath = tmpDb();
    const backend = await openSqliteBackend({
      path: dbPath,
      retention: { maxCheckpoints: 2, maxFinishedThreads: 0, finishedTtl: null },
    });
    open.push(backend);
    const memory = createScopedMemory(
      backend.memory,
      { org: "o", project: "p", graph: "g", user: "" },
      defaultMemoryPolicy(),
      { threadId: "mem" },
    );
    await memory.put("graph", "keep-me", { v: 1 });
    backend.db
      .prepare(
        `INSERT INTO fg_memory_threads
           (thread_id, org, project, graph, usr, subject_type, subject_key, created_at)
         VALUES ('short-1', 'o', 'p', 'g', '', '', '', 1)`,
      )
      .run();
    backend.db
      .prepare(`INSERT INTO fg_thread_owners (thread_id, owner, org, created_at) VALUES ('short-1', 'iss|alice', 'acme', 1)`)
      .run();
    backend.db
      .prepare(`INSERT INTO fg_memory_ops (op_id, version, value, applied_at) VALUES ('op-short-1', 1, '{"ok":true}', 1)`)
      .run();
    const before = backend.db.prepare(`SELECT COUNT(*) AS n FROM fg_memory_items`).get() as { n: number };
    expect(before.n).toBe(1);

    const spec = {
      metadata: { name: "sqlite-finished" },
      state: { channels: { tag: { type: "string" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "sqlRet", output: { to: "tag" } } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    const compiled = await compileGraph(spec, { checkpointer: backend.checkpointer });
    const result = await compiled.run({ threadId: "short-1", onInterrupt: "fail" });
    expect(result.status).toBe("completed");

    const stats = sqliteCheckpointStats(backend.db);
    expect(stats.checkpoints).toBe(0);
    const after = backend.db.prepare(`SELECT COUNT(*) AS n FROM fg_memory_items`).get() as { n: number };
    expect(after.n).toBe(1);
    const got = await memory.get("keep-me");
    expect(got?.value).toEqual({ v: 1 });
    const binding = backend.db.prepare(`SELECT COUNT(*) AS n FROM fg_memory_threads`).get() as { n: number };
    expect(binding.n).toBe(0);
    const owner = backend.db.prepare(`SELECT owner FROM fg_thread_owners WHERE thread_id = 'short-1'`).get() as { owner: string } | undefined;
    expect(owner?.owner).toBe("iss|alice");
    const ops = backend.db.prepare(`SELECT COUNT(*) AS n FROM fg_memory_ops WHERE op_id = 'op-short-1'`).get() as { n: number };
    expect(ops.n).toBe(1);
  });

  it("keeps a single blob for a channel version that does not change", async () => {
    const dbPath = tmpDb();
    const backend = await openSqliteBackend({
      path: dbPath,
      retention: { maxCheckpoints: 20, finishedTtl: null, maxFinishedThreads: null },
    });
    open.push(backend);
    const saver = backend.checkpointer as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown, versions?: unknown): Promise<unknown>;
      getTuple(config: unknown): Promise<{ checkpoint: { channel_values: Record<string, unknown> } } | undefined>;
    };
    const pad = "z".repeat(8000);
    const base = {
      v: 4,
      ts: new Date().toISOString(),
      versions_seen: {},
    };
    await saver.put(
      { configurable: { thread_id: "blob", checkpoint_ns: "" } },
      { ...base, id: "1", channel_values: { pad, n: 1 }, channel_versions: { pad: 1, n: 1 } },
      { source: "loop", step: 1, parents: {} },
      { pad: 1, n: 1 },
    );
    await saver.put(
      { configurable: { thread_id: "blob", checkpoint_ns: "", checkpoint_id: "1" } },
      { ...base, id: "2", channel_values: { pad, n: 2 }, channel_versions: { pad: 1, n: 2 } },
      { source: "loop", step: 2, parents: {} },
      { n: 2 },
    );
    const stats = sqliteCheckpointStats(backend.db);
    const padRows = backend.db
      .prepare(`SELECT COUNT(*) AS n FROM fg_checkpoint_blobs WHERE channel = 'pad'`)
      .get() as { n: number };
    expect(padRows.n).toBe(1);
    expect(stats.blobs).toBe(1);
    const tuple = await saver.getTuple({ configurable: { thread_id: "blob", checkpoint_ns: "" } });
    expect(tuple?.checkpoint.channel_values["pad"]).toBe(pad);
    expect(tuple?.checkpoint.channel_values["n"]).toBe(2);
    const stamped = backend.db.prepare(`SELECT type FROM checkpoints WHERE checkpoint_id = '2'`).get() as { type: string };
    expect(stamped.type).toBe(FG_CHECKPOINT_TYPE);
    const writes = backend.db.prepare(`SELECT COUNT(*) AS n FROM writes WHERE thread_id = 'blob'`).get() as { n: number };
    expect(writes.n).toBe(0);
  });

  it("reads deduped checkpoints when dedupe or retention is turned off, and a stock saver refuses externalized rows", async () => {
    const dbPath = tmpDb();
    const threadId = "dedupe-read";
    const spec = {
      metadata: { name: "dedupe-read" },
      state: { channels: { tag: { type: "string" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "sqlRet", output: { to: "tag" } } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    const first = createSqliteCheckpointer({ path: dbPath });
    const started = await compileGraph(spec, { checkpointer: first });
    const ran = await started.run({ threadId, onInterrupt: "fail" });
    expect(ran.status).toBe("completed");
    expect(ran.state["tag"]).toBe("done");
    (first as unknown as { db: { close(): void } }).db.close();

    for (const retention of [{ dedupeChannels: false }, false] as const) {
      const again = createSqliteCheckpointer({ path: dbPath, retention });
      const compiled = await compileGraph(spec, { checkpointer: again });
      const snap = await compiled.getState(threadId);
      expect(snap?.values["tag"]).toBe("done");
      (again as unknown as { db: { close(): void } }).db.close();
    }

    const raw = SqliteSaver.fromConnString(dbPath);
    const plain = await raw.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: "" } });
    expect(plain?.checkpoint.channel_values["tag"]).toBe("done");
    raw.db.close();

    const big = "b".repeat(8000);
    const seeded = createSqliteCheckpointer({ path: dbPath });
    const seededSaver = seeded as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown): Promise<unknown>;
      db: { close(): void };
    };
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    await seededSaver.put(
      { configurable: { thread_id: "big", checkpoint_ns: "" } },
      { ...base, id: "1", channel_values: { pad: big }, channel_versions: { pad: 1 } },
      { source: "loop", step: 1, parents: {} },
    );
    await seededSaver.put(
      { configurable: { thread_id: "big", checkpoint_ns: "", checkpoint_id: "1" } },
      { ...base, id: "2", channel_values: { pad: big }, channel_versions: { pad: 1 } },
      { source: "loop", step: 2, parents: {} },
    );
    seededSaver.db.close();
    const stock = SqliteSaver.fromConnString(dbPath);
    await expect(stock.getTuple({ configurable: { thread_id: "big", checkpoint_ns: "", checkpoint_id: "2" } })).rejects.toThrow(
      /serialization type/,
    );
    stock.db.close();
    const reread = createSqliteCheckpointer({ path: dbPath, retention: { dedupeChannels: false } });
    const loaded = await (reread as unknown as {
      getTuple(config: unknown): Promise<{ checkpoint: { channel_values: Record<string, unknown> } } | undefined>;
    }).getTuple({ configurable: { thread_id: "big", checkpoint_ns: "" } });
    expect(loaded?.checkpoint.channel_values["pad"]).toBe(big);
    (reread as unknown as { db: { close(): void } }).db.close();
  });

  it("does not delete checkpoints it never recorded, even when thread deletion is on", async () => {
    const dbPath = tmpDb();
    const spec = {
      metadata: { name: "untracked" },
      state: { channels: { tag: { type: "string" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "sqlRet", output: { to: "tag" } } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    const writer = createSqliteCheckpointer({ path: dbPath, retention: false });
    const compiled = await compileGraph(spec, { checkpointer: writer });
    expect((await compiled.run({ threadId: "old", onInterrupt: "fail" })).status).toBe("completed");
    const before = sqliteCheckpointStats((writer as unknown as { db: SqliteBackend["db"] }).db).checkpoints;
    (writer as unknown as { db: { close(): void } }).db.close();

    const reader = createSqliteCheckpointer({
      path: dbPath,
      retention: { finishedTtl: "1ms", maxFinishedThreads: 0 },
    });
    const after = sqliteCheckpointStats((reader as unknown as { db: SqliteBackend["db"] }).db).checkpoints;
    expect(after).toBe(before);
    expect(after).toBeGreaterThan(0);
    (reader as unknown as { db: { close(): void } }).db.close();
  });

  it("drops superseded pending writes and reclaims sqlite pages", async () => {
    const dbPath = tmpDb();
    const saver = createSqliteCheckpointer({ path: dbPath });
    const db = (saver as unknown as { db: SqliteBackend["db"] }).db;
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(2);
    const put = saver as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown): Promise<unknown>;
      putWrites(config: unknown, writes: [string, unknown][], taskId: string): Promise<void>;
    };
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    const big = "w".repeat(100);
    await put.put(
      { configurable: { thread_id: "w", checkpoint_ns: "" } },
      { ...base, id: "1", channel_values: { n: 1 }, channel_versions: { n: 1 } },
      { source: "loop", step: 1, parents: {} },
    );
    await put.putWrites({ configurable: { thread_id: "w", checkpoint_ns: "", checkpoint_id: "1" } }, [["n", big]], "task");
    await put.put(
      { configurable: { thread_id: "w", checkpoint_ns: "", checkpoint_id: "1" } },
      { ...base, id: "2", channel_values: { n: 2 }, channel_versions: { n: 2 } },
      { source: "loop", step: 2, parents: {} },
    );
    const left = db.prepare(`SELECT checkpoint_id FROM writes WHERE thread_id = 'w'`).all() as { checkpoint_id: string }[];
    expect(left.map((row) => row.checkpoint_id)).not.toContain("1");
    expect(Number(db.pragma("freelist_count", { simple: true }))).toBe(0);
  });

  it("keeps pending writes that arrive before the checkpoint row", async () => {
    const dbPath = tmpDb();
    const saver = createSqliteCheckpointer({ path: dbPath });
    const db = (saver as unknown as { db: SqliteBackend["db"] }).db;
    const put = saver as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown): Promise<unknown>;
      putWrites(config: unknown, writes: [string, unknown][], taskId: string): Promise<void>;
      getTuple(config: unknown): Promise<{ pendingWrites?: [string, string, unknown][] } | undefined>;
    };
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    await put.putWrites(
      { configurable: { thread_id: "w", checkpoint_ns: "", checkpoint_id: "future" } },
      [["__interrupt__", { reason: "wait" }]],
      "task",
    );
    await put.put(
      { configurable: { thread_id: "w", checkpoint_ns: "" } },
      { ...base, id: "1", channel_values: { n: 1 }, channel_versions: { n: 1 } },
      { source: "loop", step: 1, parents: {} },
    );
    await put.put(
      { configurable: { thread_id: "w", checkpoint_ns: "", checkpoint_id: "1" } },
      { ...base, id: "future", channel_values: { n: 2 }, channel_versions: { n: 2 } },
      { source: "loop", step: 2, parents: {} },
    );
    const tuple = await put.getTuple({ configurable: { thread_id: "w", checkpoint_ns: "", checkpoint_id: "future" } });
    expect(tuple?.pendingWrites?.some((write) => write[1] === "__interrupt__")).toBe(true);
    db.close();
  });

  it("keeps an interrupt's replay snapshot after a successor checkpoint is stored", async () => {
    const dbPath = tmpDb();
    const saver = createSqliteCheckpointer({ path: dbPath });
    const db = (saver as unknown as { db: SqliteBackend["db"] }).db;
    const put = saver as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown): Promise<unknown>;
      putWrites(config: unknown, writes: [string, unknown][], taskId: string): Promise<void>;
      getTuple(config: unknown): Promise<{ pendingWrites?: [string, string, unknown][] } | undefined>;
    };
    const replay = { node: '["gate"]', entries: { "0": { answer: "keep" } } };
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    await put.put(
      { configurable: { thread_id: "replay", checkpoint_ns: "" } },
      { ...base, id: "1", channel_values: { n: 1 }, channel_versions: { n: 1 } },
      { source: "loop", step: 1, parents: {} },
    );
    await put.putWrites(
      { configurable: { thread_id: "replay", checkpoint_ns: "", checkpoint_id: "1" } },
      [["__interrupt__", { value: { data: { __agentReplay: replay } } }]],
      "task",
    );
    await put.put(
      { configurable: { thread_id: "replay", checkpoint_ns: "", checkpoint_id: "1" } },
      { ...base, id: "2", channel_values: { n: 2 }, channel_versions: { n: 2 } },
      { source: "loop", step: 2, parents: {} },
    );
    const tuple = await put.getTuple({ configurable: { thread_id: "replay", checkpoint_ns: "", checkpoint_id: "1" } });
    const interrupt = tuple?.pendingWrites?.find((write) => write[1] === "__interrupt__");
    const data = (interrupt?.[2] as { value?: { data?: { __agentReplay?: unknown } } } | undefined)?.value?.data;
    expect(data?.__agentReplay).toEqual(replay);
    db.close();
  });

  it("keeps pending writes that were stored before their checkpoint once the window is exceeded", async () => {
    const dbPath = tmpDb();
    const saver = createSqliteCheckpointer({
      path: dbPath,
      retention: { maxCheckpoints: 1, maxInterruptPoints: 0, finishedTtl: null },
    });
    const db = (saver as unknown as { db: SqliteBackend["db"] }).db;
    const put = saver as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown): Promise<unknown>;
      putWrites(config: unknown, writes: [string, unknown][], taskId: string): Promise<void>;
    };
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    const cp = (id: string, parent?: string) =>
      put.put(
        { configurable: { thread_id: "gap", checkpoint_ns: "", ...(parent ? { checkpoint_id: parent } : {}) } },
        { ...base, id, channel_values: { n: id }, channel_versions: { n: id } },
        { source: "loop", step: 1, parents: {} },
      );
    await cp("1");
    await cp("2", "1");
    await put.putWrites(
      { configurable: { thread_id: "gap", checkpoint_ns: "", checkpoint_id: "future" } },
      [["side", "S"], ["__interrupt__", { reason: "wait" }]],
      "task",
    );
    await cp("3", "2");
    const writes = db.prepare(`SELECT channel FROM writes WHERE thread_id = 'gap' AND checkpoint_id = 'future'`).all() as { channel: string }[];
    expect(writes.map((row) => row.channel).sort()).toEqual(["__interrupt__", "side"]);
    db.close();
  });

  it("refuses a checkpoint schema newer than this build", () => {
    const dbPath = tmpDb();
    const first = createSqliteCheckpointer({ path: dbPath, retention: false });
    const db = (first as unknown as { db: SqliteBackend["db"] }).db;
    db.prepare(`INSERT INTO fg_schema_migrations (component, version, applied_at) VALUES ('checkpoint', 99, 1)`).run();
    db.close();
    expect(() => createSqliteCheckpointer({ path: dbPath })).toThrow(/newer than this flowgraph/);
  });

  it("a thread past the window still runs a parallel interrupt and its side effect once", async () => {
    const off = createSqliteCheckpointer({ path: tmpDb(), retention: false });
    const on = createSqliteCheckpointer({
      path: tmpDb(),
      retention: { maxCheckpoints: 3, maxInterruptPoints: 8, finishedTtl: null },
    });
    const spec = parallelSpec(8);
    const plain = await drive(off, spec, { n: 0 });
    const kept = await drive(on, spec, { n: 0 });
    expect(kept).toEqual(plain);
    expect(plain.hits).toEqual(["S"]);
    expect(plain.status).toBe("completed");
    (off as unknown as { db: { close(): void } }).db.close();
    (on as unknown as { db: { close(): void } }).db.close();
  });

  it("a thread past the window resumes a map interrupt the same way as retention off", async () => {
    const off = createSqliteCheckpointer({ path: tmpDb(), retention: false });
    const on = createSqliteCheckpointer({
      path: tmpDb(),
      retention: { maxCheckpoints: 3, maxInterruptPoints: 8, finishedTtl: null },
    });
    const spec = mapSpec(8);
    const plain = await drive(off, spec, { n: 0, numbers: [1, 2] });
    const kept = await drive(on, spec, { n: 0, numbers: [1, 2] });
    expect(kept).toEqual(plain);
    expect(plain.status).toBe("completed");
    expect(plain.out).toHaveLength(2);
    (off as unknown as { db: { close(): void } }).db.close();
    (on as unknown as { db: { close(): void } }).db.close();
  });

  it("map interrupts with maxCheckpoints 1 match retention off", async () => {
    const off = createSqliteCheckpointer({ path: tmpDb(), retention: false });
    const on = createSqliteCheckpointer({
      path: tmpDb(),
      retention: { maxCheckpoints: 1, maxInterruptPoints: 8, finishedTtl: null },
    });
    const spec = mapSpec(0);
    const plain = await drive(off, spec, { numbers: [1, 2] });
    const kept = await drive(on, spec, { numbers: [1, 2] });
    expect(kept).toEqual(plain);
    expect(plain.status).toBe("completed");
    (off as unknown as { db: { close(): void } }).db.close();
    (on as unknown as { db: { close(): void } }).db.close();
  });

  it("does not delete a thread another run has left waiting at an interrupt", () => {
    const saver = createSqliteCheckpointer({
      path: tmpDb(),
      retention: { maxFinishedThreads: 0, finishedTtl: null },
    });
    const db = (saver as unknown as { db: SqliteBackend["db"] }).db;
    const api = saver as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown): Promise<unknown>;
      beginThreadRun(threadId: string): void;
      endThreadRun(threadId: string, status: "paused" | "finished"): void;
      noteThreadStatus(threadId: string, status: "paused" | "finished"): void;
    };
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    const put = (threadId: string) =>
      api.put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        { ...base, id: "1", channel_values: { n: 1 }, channel_versions: { n: 1 } },
        { source: "loop", step: 1, parents: {} },
      );
    return put("waiting").then(async () => {
      api.beginThreadRun("waiting");
      api.noteThreadStatus("waiting", "finished");
      expect((db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = 'waiting'`).get() as { n: number }).n).toBeGreaterThan(0);
      api.endThreadRun("waiting", "paused");
      await put("other");
      api.noteThreadStatus("other", "finished");
      expect((db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = 'waiting'`).get() as { n: number }).n).toBeGreaterThan(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = 'other'`).get() as { n: number }).n).toBe(0);
      db.close();
    });
  });
});
