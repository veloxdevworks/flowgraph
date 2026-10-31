import { afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  compileGraph,
  registerFunction,
  resolveCheckpointRetention,
  THREAD_MOVED_ON,
  type CheckpointRetentionInput,
} from "@flowgraph/core";
import { openPostgresBackend } from "./index.js";
import { FlowgraphPostgresSaver, activeMarkLockKey } from "./retention.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

const pools: pg.Pool[] = [];
const schemas: string[] = [];
afterEach(async () => {
  const pending = schemas.splice(0);
  const live = pools.splice(0);
  if (DB && pending.length > 0) {
    const admin = new pg.Pool({ connectionString: DB });
    try {
      for (const schema of pending) {
        if (/^fg_stale_[a-z0-9]+$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await admin.end();
    }
  }
  for (const pool of live) await pool.end();
});

function schemaName(): string {
  const schema = `fg_stale_${Math.random().toString(36).slice(2, 10)}`;
  schemas.push(schema);
  return schema;
}

async function saverAt(retention: CheckpointRetentionInput, schema: string, setup = true, poolConfig: pg.PoolConfig = {}) {
  const pool = new pg.Pool({ connectionString: DB!, max: 4, ...poolConfig });
  pools.push(pool);
  const clock = { now: T0 };
  const saver = new FlowgraphPostgresSaver(pool, resolveCheckpointRetention(retention), { schema, clock: () => clock.now });
  if (setup) await saver.setup();
  return { saver, clock, pool };
}

const cfg = (threadId: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: "" } });

async function write(saver: FlowgraphPostgresSaver, threadId: string, step: number): Promise<void> {
  await saver.put(
    cfg(threadId),
    {
      v: 4,
      id: `c${String(step).padStart(4, "0")}`,
      ts: new Date(T0).toISOString(),
      channel_values: { n: step },
      channel_versions: { n: String(step) },
      versions_seen: {},
    },
    { source: "loop", step, parents: {} },
    { n: String(step) },
  );
}

async function checkpointCount(pool: pg.Pool, schema: string, threadId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM "${schema}".checkpoints WHERE thread_id = $1`, [threadId]);
  return Number(r.rows[0]?.n ?? 0);
}

describe.skipIf(!DB)("postgres abandoned active threads", () => {
  it("migrates the checkpoint schema to version 4 with active_ttl_ms", async () => {
    const schema = schemaName();
    const { pool } = await saverAt({ finishedTtl: "1h" }, schema);
    const v = await pool.query<{ v: number }>(
      `SELECT MAX(version) AS v FROM "${schema}".fg_schema_migrations WHERE component = 'checkpoint'`,
    );
    expect(v.rows[0]?.v).toBe(4);
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fg_checkpoint_threads' AND column_name = 'active_ttl_ms'`,
      [schema],
    );
    expect(col.rowCount).toBe(1);
    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'fg_checkpoint_threads_active'`,
      [schema],
    );
    expect(index.rows[0]?.indexdef).toMatch(/WHERE \(status = 'active'::text\)/);
  });

  it("sweeps an active row whose run stopped past the limit", async () => {
    const schema = schemaName();
    const { saver, clock, pool } = await saverAt({ finishedTtl: "1h", activeTtl: "1d" }, schema);
    await saver.markThreadActive("crashed");
    await write(saver, "crashed", 1);
    clock.now = T0 + DAY + HOUR;
    await saver.sweep();
    expect(await saver.savedThreadStatus("crashed")).toBeUndefined();
    expect(await checkpointCount(pool, schema, "crashed")).toBe(0);
  });

  it("a later host's setup sweeps a row the crashed host left active", async () => {
    const schema = schemaName();
    const first = await saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, schema);
    await first.saver.markThreadActive("left");
    await write(first.saver, "left", 1);
    const second = await saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, schema, false);
    second.clock.now = T0 + DAY;
    await second.saver.setup();
    expect(await second.saver.savedThreadStatus("left")).toBeUndefined();
    expect(await checkpointCount(second.pool, schema, "left")).toBe(0);
  });

  it("keeps an active row inside the limit", async () => {
    const schema = schemaName();
    const { saver, pool } = await saverAt({ finishedTtl: "1h", activeTtl: "1d" }, schema);
    await saver.markThreadActive("recent");
    await write(saver, "recent", 1);
    await saver.sweep(T0 + DAY - 1);
    expect((await saver.savedThreadStatus("recent"))?.status).toBe("active");
    expect(await checkpointCount(pool, schema, "recent")).toBe(1);
  });

  it("an abandoned row is finished as of its last activity and then follows finishedTtl", async () => {
    const schema = schemaName();
    const { saver, pool } = await saverAt({ finishedTtl: "3d", activeTtl: "1d" }, schema);
    await saver.markThreadActive("aging");
    await write(saver, "aging", 1);
    await saver.sweep(T0 + 2 * DAY);
    expect(await saver.savedThreadStatus("aging")).toEqual({ status: "finished", updatedAt: T0 });
    await saver.sweep(T0 + 3 * DAY - 1);
    expect(await checkpointCount(pool, schema, "aging")).toBe(1);
    await saver.sweep(T0 + 3 * DAY);
    expect(await checkpointCount(pool, schema, "aging")).toBe(0);
  });

  it("a run that keeps writing checkpoints is never swept by another host", async () => {
    const schema = schemaName();
    const writer = await saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, schema);
    const sweeper = await saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, schema, false);
    await writer.saver.markThreadActive("live");
    for (let step = 1; step <= 6; step++) {
      writer.clock.now = T0 + step * 20 * HOUR;
      await write(writer.saver, "live", step);
      await sweeper.saver.sweep(writer.clock.now + 20 * HOUR);
      expect((await sweeper.saver.savedThreadStatus("live"))?.status).toBe("active");
    }
    expect(writer.clock.now - T0).toBeGreaterThan(4 * DAY);
    expect(await checkpointCount(writer.pool, schema, "live")).toBe(6);
  });

  it("a run this process holds is kept however old", async () => {
    const schema = schemaName();
    const { saver } = await saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, schema);
    const token = saver.beginThreadRun("held");
    await saver.markThreadActive("held");
    await write(saver, "held", 1);
    await saver.sweep(T0 + 30 * DAY);
    expect((await saver.savedThreadStatus("held"))?.status).toBe("active");
    saver.endThreadRun("held", "active", token, false, true);
    await saver.sweep(T0 + 30 * DAY);
    expect(await saver.savedThreadStatus("held")).toBeUndefined();
  });

  it("an active row from before schema 4 uses the sweeping saver's policy", async () => {
    const schema = schemaName();
    const { saver, pool } = await saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" }, schema);
    await write(saver, "old", 1);
    await pool.query(
      `UPDATE "${schema}".fg_checkpoint_threads
       SET updated_at = $1, active_ttl_ms = NULL, finished_ttl_ms = NULL, max_finished = NULL, active_mark = 'm'
       WHERE thread_id = 'old'`,
      [T0],
    );
    await saver.sweep(T0 + DAY - 1);
    expect((await saver.savedThreadStatus("old"))?.status).toBe("active");
    await saver.sweep(T0 + DAY);
    expect(await saver.savedThreadStatus("old")).toBeUndefined();
    expect(await checkpointCount(pool, schema, "old")).toBe(0);
  });

  it("a stale run that wakes after its row was reclaimed does not clobber a newer mark", async () => {
    const schema = schemaName();
    const { saver, clock } = await saverAt({ finishedTtl: null, maxFinishedThreads: 10, activeTtl: "1d" }, schema);
    const stale = (await saver.markThreadActive("woken"))!;
    await saver.sweep(T0 + 2 * DAY);
    expect(await saver.savedThreadStatus("woken")).toEqual({ status: "finished", updatedAt: T0 });

    clock.now = T0 + 2 * DAY + 1;
    const fresh = (await saver.markThreadActive("woken"))!;
    expect(fresh.prior).toEqual({ status: "finished", updatedAt: T0 });

    clock.now += 1;
    await write(saver, "woken", 1);
    await saver.restoreThreadStatus("woken", stale.prior, stale.mark);
    expect((await saver.savedThreadStatus("woken"))?.status).toBe("active");

    await saver.restoreThreadStatus("woken", fresh.prior, fresh.mark);
    expect(await saver.savedThreadStatus("woken")).toEqual({ status: "finished", updatedAt: T0 });
  });

  it("the active-mark lock is per schema, so two schemas do not block each other", async () => {
    expect(activeMarkLockKey("a", "t")).not.toBe(activeMarkLockKey("b", "t"));
    expect(activeMarkLockKey("a:b", "c")).not.toBe(activeMarkLockKey("a", "b:c"));
    const retention = { finishedTtl: "1h", activeTtl: "1d" } as const;
    const left = schemaName();
    const right = schemaName();
    const a = await saverAt(retention, left);
    const b = await saverAt(retention, right);
    // Same schema as `a`, but a lock wait fails fast instead of blocking.
    const impatient = await saverAt(retention, left, false, { options: "-c lock_timeout=100" });
    const holder = await a.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [activeMarkLockKey(left, "shared")]);
      // Another schema's saver takes its own lock and does not wait.
      const other = await b.saver.markThreadActive("shared");
      expect(other?.mark).toBeTruthy();
      // The same schema's saver has to wait on the held key.
      await expect(impatient.saver.markThreadActive("shared")).rejects.toMatchObject({ code: "55P03" });
      expect(await a.saver.savedThreadStatus("shared")).toBeUndefined();
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    const same = await impatient.saver.markThreadActive("shared");
    expect(same?.mark).toBeTruthy();
    expect((await a.saver.savedThreadStatus("shared"))?.status).toBe("active");
    expect((await b.saver.savedThreadStatus("shared"))?.status).toBe("active");
  });

  it("a restore given the mark time leaves a row written after the mark", async () => {
    const schema = schemaName();
    const { saver, clock } = await saverAt({ finishedTtl: "1h", activeTtl: "1d" }, schema);
    const marked = (await saver.markThreadActive("written"))!;
    expect(marked.markedAt).toBe(T0);
    clock.now = T0 + 5;
    await write(saver, "written", 1);
    await saver.restoreThreadStatus("written", { status: "finished", updatedAt: T0 - DAY }, marked.mark, marked.markedAt);
    expect(await saver.savedThreadStatus("written")).toEqual({ status: "active", updatedAt: T0 + 5 });
    await saver.restoreThreadStatus("written", undefined, marked.mark, marked.markedAt);
    expect((await saver.savedThreadStatus("written"))?.status).toBe("active");

    const other = (await saver.markThreadActive("untouched"))!;
    await saver.restoreThreadStatus("untouched", { status: "paused", updatedAt: T0 - DAY }, other.mark, other.markedAt);
    expect(await saver.savedThreadStatus("untouched")).toEqual({ status: "paused", updatedAt: T0 - DAY });
  });

  it("openPostgresBackend passes its clock to the saver", async () => {
    const schema = schemaName();
    const backend = await openPostgresBackend({
      connectionString: DB!,
      schema,
      retention: { finishedTtl: "1h" },
      clock: () => T0 + 42,
    });
    try {
      const saver = backend.checkpointer as unknown as FlowgraphPostgresSaver;
      expect((await saver.markThreadActive("clocked"))?.markedAt).toBe(T0 + 42);
      expect(await saver.savedThreadStatus("clocked")).toEqual({ status: "active", updatedAt: T0 + 42 });
    } finally {
      await backend.close();
    }
  });
});

/** pre -> gate -> post. `gate` is a human approval, or a breakpoint before `post`. */
function gatedSpec(gate: "approval" | "breakpoint"): Parameters<typeof compileGraph>[0] {
  const nodes: unknown[] = [{ id: "pre", type: "function", with: { fn: "pgWaitPre", output: { to: "a" } } }];
  const edges: unknown[] = [{ from: "START", to: "pre" }];
  if (gate === "approval") {
    nodes.push({ id: "gate", type: "hitl", with: { mode: "approve", message: "ok?", output: { to: "approval" } } });
    edges.push({ from: "pre", to: "gate" }, { from: "gate", to: "post" });
  } else {
    edges.push({ from: "pre", to: "post" });
  }
  nodes.push({ id: "post", type: "function", with: { fn: "pgWaitPost", output: { to: "b" } } });
  edges.push({ from: "post", to: "END" });
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: `pg-wait-${gate}` },
    state: { channels: { a: { type: "string" }, b: { type: "string" }, approval: { type: "object" } } },
    nodes,
    edges,
    ...(gate === "breakpoint" ? { runtime: { hitl: { breakpoints: { before: ["post"] } } } } : {}),
  } as unknown as Parameters<typeof compileGraph>[0];
}

describe.skipIf(!DB)("postgres run waiting for an answer", () => {
  const seenInPost: Array<string | undefined> = [];
  let observe: (() => Promise<string | undefined>) | undefined;
  beforeAll(() => {
    registerFunction("pgWaitPre", () => "pre");
    registerFunction("pgWaitPost", async () => {
      seenInPost.push(await observe?.());
      return "post";
    });
  });

  for (const gate of ["approval", "breakpoint"] as const) {
    it(`another host past activeTtl does not reclaim a run waiting at ${gate === "approval" ? "an approval" : "a breakpoint"}`, async () => {
      const schema = schemaName();
      const retention = { finishedTtl: "1h" } as const;
      const a = await saverAt(retention, schema);
      const b = await saverAt(retention, schema);
      b.clock.now = T0 + 8 * DAY;
      const threadId = `waiting-${gate}`;
      observe = async () => (await b.saver.savedThreadStatus(threadId))?.status;
      seenInPost.length = 0;
      const graph = await compileGraph(gatedSpec(gate), { checkpointer: a.saver as never });
      let whileWaiting: string | undefined;
      let afterSweep: string | undefined;
      const result = await graph.run({
        threadId,
        input: {},
        onInterrupt: "prompt",
        resolveInterrupt: async () => {
          whileWaiting = (await b.saver.savedThreadStatus(threadId))?.status;
          await b.saver.sweep();
          afterSweep = (await b.saver.savedThreadStatus(threadId))?.status;
          return { approved: true };
        },
      });
      expect(whileWaiting).toBe("paused");
      expect(afterSweep).toBe("paused");
      expect(seenInPost).toEqual(["active"]);
      expect(result.status).toBe("completed");
      expect(result.state["a"]).toBe("pre");
      expect(result.state["b"]).toBe("post");
      expect(await checkpointCount(a.pool, schema, threadId)).toBeGreaterThan(0);
      expect((await b.saver.savedThreadStatus(threadId))?.status).toBe("finished");
    });
  }

  it("a run whose thread another host took over while it waited stops without applying the answer", async () => {
    const retention = { finishedTtl: "1h" } as const;
    const schema = schemaName();
    const a = await saverAt(retention, schema);
    const b = await saverAt(retention, schema);
    b.clock.now = T0 + 1;
    const threadId = "taken-over";
    observe = undefined;
    seenInPost.length = 0;
    const graph = await compileGraph(gatedSpec("approval"), { checkpointer: a.saver as never });
    const result = await graph.run({
      threadId,
      input: {},
      onInterrupt: "prompt",
      resolveInterrupt: async () => {
        await b.saver.markThreadActive(threadId);
        return { approved: true };
      },
    });
    expect(result.status).toBe("error");
    expect((result.error as { code?: string }).code).toBe(THREAD_MOVED_ON);
    expect(seenInPost).toEqual([]);
    expect(await b.saver.savedThreadStatus(threadId)).toEqual({ status: "active", updatedAt: T0 + 1 });
  });
});
