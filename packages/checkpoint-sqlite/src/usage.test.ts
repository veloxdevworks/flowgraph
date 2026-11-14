import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph, createScriptedProvider, type GraphSpec, type UsageCheckpointStore } from "@flowgraph/core";
import { openSqliteBackend, type SqliteBackend } from "./index.js";
const dirs: string[] = [], opened: SqliteBackend[] = [];
afterEach(() => { for (const backend of opened.splice(0)) backend.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("atomically merges a late response across SQLite connections and refuses stale revisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-usage-late-")); dirs.push(dir);
  const a = await openSqliteBackend(join(dir, "cp.db")), b = await openSqliteBackend(join(dir, "cp.db")); opened.push(a, b);
  let release!: () => void, charged!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), done = new Promise<void>(resolve => { charged = resolve; });
  const graph = (timeout?: string) => ({ metadata: { name: "late" }, nodes: [{ id: "a", type: "agent", provider: "usage-qa", ...(timeout ? { timeout } : {}), with: { prompt: "answer" } }], edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }] }) as unknown as GraphSpec;
  const first = await compileGraph(graph("50ms"), { checkpointer: a.checkpointer, providers: [createScriptedProvider("usage-qa", async () => { await hold; return { output: "done", stopReason: "done", usage: { totalTokens: 4, costUSD: 0.001 } }; })] });
  first.events.subscribe(event => { if (event.type === "agent.usage") charged(); });
  try {
    expect(await first.run({ threadId: "late" })).toMatchObject({ status: "error", usage: { pendingCalls: 1 } });
    const second = await compileGraph(graph(), { checkpointer: b.checkpointer, providers: [createScriptedProvider("usage-qa", () => ({ output: "done", stopReason: "done", usage: { totalTokens: 5, costUSD: 0.002 } }))] });
    expect(await second.resume({ threadId: "late", resume: true })).toMatchObject({ status: "completed", usage: { totalTokens: 5, pendingCalls: 1 } });
  } finally { release(); }
  await done;
  const store = b.checkpointer as unknown as UsageCheckpointStore, record = (await store.readThreadUsage("late"))!;
  expect(record.totals).toMatchObject({ calls: 2, totalTokens: 9, costUSD: 0.003 }); expect(record.pending).toEqual({});
  expect(await store.compareThreadUsage!("late", record.revision! - 1, record)).toBe(false);
});
