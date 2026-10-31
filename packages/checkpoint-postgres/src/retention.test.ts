import { afterEach, describe, expect, it } from "vitest";
import { compileGraph, registerFunction, type GraphSpec } from "@flowgraph/core";
import { openPostgresBackend, type PostgresBackend } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

registerFunction("pgRet", () => "done");

const open: PostgresBackend[] = [];
const schemas: string[] = [];
afterEach(async () => {
  const pending = schemas.splice(0);
  for (const backend of open.splice(0)) await backend.close();
  if (!DB) return;
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: DB });
  try {
    for (const schema of pending) {
      if (/^fg_ret_[a-z0-9]+$/.test(schema)) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await pool.end();
  }
});

function schemaName(): string {
  return `fg_ret_${Math.random().toString(36).slice(2, 10)}`;
}

const interruptSpec = {
  metadata: { name: "pg-retain" },
  state: { channels: { tag: { type: "string" } } },
  nodes: [
    { id: "gate", type: "wait", with: { signal: "go" } },
    { id: "a", type: "function", with: { fn: "pgRet", output: { to: "tag" } } },
    { id: "b", type: "function", with: { fn: "pgRet", output: { to: "tag" } } },
    { id: "c", type: "function", with: { fn: "pgRet", output: { to: "tag" } } },
    { id: "d", type: "function", with: { fn: "pgRet", output: { to: "tag" } } },
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

describe.skipIf(!DB)("postgres checkpoint retention", () => {
  it("resumes a paused thread after pruning and keeps the interrupt checkpoint", async () => {
    const schema = schemaName();
    const backend = await openPostgresBackend({
      connectionString: DB!,
      schema,
      retention: { maxCheckpoints: 2, maxInterruptPoints: 4, finishedTtl: null, maxFinishedThreads: null },
    });
    open.push(backend);
    schemas.push(schema);
    const threadId = `pg-${schema}`;
    const compiled = await compileGraph(interruptSpec, { checkpointer: backend.checkpointer });
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

    const again = await compiled.resumeFrom({
      threadId,
      checkpointId: interruptId!,
      resume: { go: true },
      onInterrupt: "fail",
    });
    expect(again.status).toBe("completed");
    expect(again.state["tag"]).toBe("done");
  });

  it("deletes finished threads and leaves fg_memory rows in place", async () => {
    const schema = schemaName();
    const backend = await openPostgresBackend({
      connectionString: DB!,
      schema,
      retention: { maxCheckpoints: 2, maxFinishedThreads: 0, finishedTtl: null },
    });
    open.push(backend);
    schemas.push(schema);
    await backend.pool.query(
      `INSERT INTO "${schema}".fg_memory_items
        (org, project, graph, usr, subject_type, subject_key, key, value, attrs, bytes, version, created_at, updated_at)
       VALUES ('o', 'p', 'g', '', '', '', 'keep-me', '{"v":1}'::json, '{}'::jsonb, 8, 1, 1, 1)`,
    );
    const spec = {
      metadata: { name: "pg-finished" },
      state: { channels: { tag: { type: "string" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "pgRet", output: { to: "tag" } } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    const threadId = `done-${schema}`;
    await backend.pool.query(
      `INSERT INTO "${schema}".fg_thread_owners (thread_id, owner, org, created_at) VALUES ($1, 'iss|alice', 'acme', 1)`,
      [threadId],
    );
    await backend.pool.query(
      `INSERT INTO "${schema}".fg_memory_ops (op_id, version, value, applied_at) VALUES ($1, 1, '{"ok":true}'::json, 1)`,
      [`op-${threadId}`],
    );
    const compiled = await compileGraph(spec, { checkpointer: backend.checkpointer });
    const result = await compiled.run({ threadId, onInterrupt: "fail" });
    expect(result.status).toBe("completed");
    const checkpoints = await backend.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM "${schema}".checkpoints`,
    );
    expect(Number(checkpoints.rows[0]?.n)).toBe(0);
    const memory = await backend.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM "${schema}".fg_memory_items`,
    );
    expect(Number(memory.rows[0]?.n)).toBe(1);
    const owner = await backend.pool.query<{ owner: string }>(
      `SELECT owner FROM "${schema}".fg_thread_owners WHERE thread_id = $1`,
      [threadId],
    );
    expect(owner.rows[0]?.owner).toBe("iss|alice");
    const ops = await backend.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM "${schema}".fg_memory_ops WHERE op_id = $1`,
      [`op-${threadId}`],
    );
    expect(Number(ops.rows[0]?.n)).toBe(1);
  });

  it("drops channel blob versions no remaining checkpoint references", async () => {
    const schema = schemaName();
    const backend = await openPostgresBackend({
      connectionString: DB!,
      schema,
      retention: { maxCheckpoints: 1, maxInterruptPoints: 0, finishedTtl: null, maxFinishedThreads: null },
    });
    open.push(backend);
    schemas.push(schema);
    const saver = backend.checkpointer as {
      put(config: unknown, checkpoint: unknown, metadata: unknown, versions: unknown): Promise<unknown>;
      getTuple(config: unknown): Promise<{ checkpoint: { channel_values: Record<string, unknown> } } | undefined>;
    };
    const pad = "q".repeat(2000);
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    await saver.put(
      { configurable: { thread_id: "blob", checkpoint_ns: "" } },
      { ...base, id: "1", channel_values: { pad, n: 1 }, channel_versions: { pad: "1", n: "1" } },
      { source: "loop", step: 1, parents: {} },
      { pad: "1", n: "1" },
    );
    await saver.put(
      { configurable: { thread_id: "blob", checkpoint_ns: "", checkpoint_id: "1" } },
      { ...base, id: "2", channel_values: { pad, n: 2 }, channel_versions: { pad: "1", n: "2" } },
      { source: "loop", step: 2, parents: {} },
      { n: "2" },
    );
    const blobs = await backend.pool.query<{ channel: string }>(
      `SELECT channel FROM "${schema}".checkpoint_blobs WHERE thread_id = 'blob' ORDER BY channel`,
    );
    expect(blobs.rows.map((row) => row.channel).sort()).toEqual(["n", "pad"]);
    const tuple = await saver.getTuple({ configurable: { thread_id: "blob", checkpoint_ns: "" } });
    expect(tuple?.checkpoint.channel_values["pad"]).toBe(pad);
    expect(tuple?.checkpoint.channel_values["n"]).toBe(2);
    const checkpoints = await backend.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM "${schema}".checkpoints WHERE thread_id = 'blob'`,
    );
    expect(Number(checkpoints.rows[0]?.n)).toBe(1);
  });
});
