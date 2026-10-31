import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCheckpointRetention, type CheckpointRetentionInput } from "@flowgraph/core";
import { openDatabase } from "./memory.js";
import { FlowgraphSqliteSaver } from "./retention.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

const tmpFiles: string[] = [];
const dbs: Array<{ close(): void }> = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const file of tmpFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  }
});

function saverAt(retention: CheckpointRetentionInput, file?: string) {
  const dbPath = file ?? path.join(os.tmpdir(), `fg-stale-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  if (!file) tmpFiles.push(dbPath);
  const db = openDatabase(dbPath);
  dbs.push(db);
  const clock = { now: T0 };
  const saver = new FlowgraphSqliteSaver(db, resolveCheckpointRetention(retention), { clock: () => clock.now });
  saver.prepare();
  return { saver, clock, db, dbPath };
}

const cfg = (threadId: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: "" } });

async function write(saver: FlowgraphSqliteSaver, threadId: string, step: number): Promise<void> {
  await saver.put(
    cfg(threadId),
    {
      v: 4,
      id: `c${String(step).padStart(4, "0")}`,
      ts: new Date(T0).toISOString(),
      channel_values: { n: step },
      channel_versions: { n: step },
      versions_seen: {},
    },
    { source: "loop", step, parents: {} },
    { n: step },
  );
}

function checkpointCount(saver: FlowgraphSqliteSaver, threadId: string): number {
  const db = (saver as unknown as { sqlite: { prepare(sql: string): { get(...a: unknown[]): unknown } } }).sqlite;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?`).get(threadId) as { n: number };
  return Number(row.n);
}

describe("sqlite abandoned active threads", () => {
  it("migrates the checkpoint schema to version 4 with active_ttl_ms", () => {
    const { db } = saverAt({ finishedTtl: "1h" });
    const v = db.prepare(`SELECT MAX(version) AS v FROM fg_schema_migrations WHERE component = 'checkpoint'`).get() as { v: number };
    expect(v.v).toBe(4);
    const cols = (db.prepare(`PRAGMA table_info(fg_checkpoint_threads)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("active_ttl_ms");
  });

  it("sweeps an active row whose run stopped past the limit", async () => {
    const { saver, clock } = saverAt({ finishedTtl: "1h", activeTtl: "1d" });
    saver.markThreadActive("crashed");
    await write(saver, "crashed", 1);
    clock.now = T0 + DAY + HOUR;
    saver.sweep();
    expect(saver.savedThreadStatus("crashed")).toBeUndefined();
    expect(checkpointCount(saver, "crashed")).toBe(0);
  });

  it("a later process sweeps a row the crashed process left active", async () => {
    const first = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" });
    first.saver.markThreadActive("left");
    await write(first.saver, "left", 1);
    const second = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, first.dbPath);
    second.clock.now = T0 + DAY;
    second.saver.sweep();
    expect(second.saver.savedThreadStatus("left")).toBeUndefined();
    expect(checkpointCount(second.saver, "left")).toBe(0);
  });

  it("keeps an active row inside the limit", async () => {
    const { saver } = saverAt({ finishedTtl: "1h", activeTtl: "1d" });
    saver.markThreadActive("recent");
    await write(saver, "recent", 1);
    saver.sweep(T0 + DAY - 1);
    expect(saver.savedThreadStatus("recent")?.status).toBe("active");
    expect(checkpointCount(saver, "recent")).toBe(1);
  });

  it("an abandoned row is finished as of its last activity and then follows finishedTtl", async () => {
    const { saver } = saverAt({ finishedTtl: "3d", activeTtl: "1d" });
    saver.markThreadActive("aging");
    await write(saver, "aging", 1);
    saver.sweep(T0 + 2 * DAY);
    expect(saver.savedThreadStatus("aging")).toEqual({ status: "finished", updatedAt: T0 });
    saver.sweep(T0 + 3 * DAY - 1);
    expect(checkpointCount(saver, "aging")).toBe(1);
    saver.sweep(T0 + 3 * DAY);
    expect(checkpointCount(saver, "aging")).toBe(0);
  });

  it("a run that keeps writing checkpoints is never swept by another saver", async () => {
    const writer = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" });
    const sweeper = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, writer.dbPath);
    writer.saver.markThreadActive("live");
    for (let step = 1; step <= 10; step++) {
      writer.clock.now = T0 + step * 20 * HOUR;
      await write(writer.saver, "live", step);
      sweeper.saver.sweep(writer.clock.now + 20 * HOUR);
      expect(sweeper.saver.savedThreadStatus("live")?.status).toBe("active");
    }
    expect(writer.clock.now - T0).toBeGreaterThan(8 * DAY);
    expect(checkpointCount(writer.saver, "live")).toBe(10);
  });

  it("a run this process holds is kept however old", async () => {
    const { saver } = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" });
    const token = saver.beginThreadRun("held");
    saver.markThreadActive("held");
    await write(saver, "held", 1);
    saver.sweep(T0 + 30 * DAY);
    expect(saver.savedThreadStatus("held")?.status).toBe("active");
    saver.endThreadRun("held", "active", token, false, true);
    saver.sweep(T0 + 30 * DAY);
    expect(saver.savedThreadStatus("held")).toBeUndefined();
  });

  it("the row keeps the run's graph policy, not the sweeping saver's", async () => {
    const writer = saverAt({ maxFinishedThreads: null, finishedTtl: "1h", activeTtl: "7d" });
    writer.saver.noteThreadPolicy("graph", resolveCheckpointRetention({ activeTtl: null, finishedTtl: "1h" }));
    writer.saver.markThreadActive("graph");
    await write(writer.saver, "graph", 1);
    const sweeper = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, writer.dbPath);
    sweeper.saver.sweep(T0 + 365 * DAY);
    expect(sweeper.saver.savedThreadStatus("graph")?.status).toBe("active");
  });

  it("an active row from before schema 4 uses the sweeping saver's policy", async () => {
    const { saver, db } = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" });
    await write(saver, "old", 1);
    db.prepare(
      `UPDATE fg_checkpoint_threads SET updated_at = ?, active_ttl_ms = NULL, finished_ttl_ms = NULL, max_finished = NULL, active_mark = 'm'
       WHERE thread_id = 'old'`,
    ).run(T0);
    saver.sweep(T0 + DAY - 1);
    expect(saver.savedThreadStatus("old")?.status).toBe("active");
    saver.sweep(T0 + DAY);
    expect(saver.savedThreadStatus("old")).toBeUndefined();
    expect(checkpointCount(saver, "old")).toBe(0);
  });

  it("a stale run that wakes after its row was reclaimed does not clobber a newer mark", async () => {
    const { saver, clock } = saverAt({ finishedTtl: null, maxFinishedThreads: 10, activeTtl: "1d" });
    const stale = saver.markThreadActive("woken")!;
    saver.sweep(T0 + 2 * DAY);
    expect(saver.savedThreadStatus("woken")).toEqual({ status: "finished", updatedAt: T0 });

    clock.now = T0 + 2 * DAY + 1;
    const fresh = saver.markThreadActive("woken")!;
    expect(fresh.prior).toEqual({ status: "finished", updatedAt: T0 });

    clock.now += 1;
    await write(saver, "woken", 1);
    saver.restoreThreadStatus("woken", stale.prior, stale.mark);
    expect(saver.savedThreadStatus("woken")?.status).toBe("active");

    saver.restoreThreadStatus("woken", fresh.prior, fresh.mark);
    expect(saver.savedThreadStatus("woken")).toEqual({ status: "finished", updatedAt: T0 });
  });
});
