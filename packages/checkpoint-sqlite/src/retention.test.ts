import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph, createScopedMemory, defaultMemoryPolicy, registerFunction, type GraphSpec } from "@flowgraph/core";
import { createSqliteCheckpointer, openSqliteBackend, sqliteCheckpointStats, type SqliteBackend } from "./index.js";

registerFunction("sqlRet", () => "done");

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
    const pad = "z".repeat(3000);
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
    expect(stats.blobs).toBe(3);
    const padRows = backend.db
      .prepare(`SELECT COUNT(*) AS n FROM fg_checkpoint_blobs WHERE channel = 'pad'`)
      .get() as { n: number };
    expect(padRows.n).toBe(1);
    const tuple = await saver.getTuple({ configurable: { thread_id: "blob", checkpoint_ns: "" } });
    expect(tuple?.checkpoint.channel_values["pad"]).toBe(pad);
    expect(tuple?.checkpoint.channel_values["n"]).toBe(2);
    expect(stats.checkpointBytes).toBeLessThan(pad.length);
  });
});
