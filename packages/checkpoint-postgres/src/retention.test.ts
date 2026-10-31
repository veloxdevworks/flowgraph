import { afterEach, describe, expect, it } from "vitest";
import { compileGraph, registerFunction, type GraphSpec } from "@flowgraph/core";
import { openPostgresBackend, type PostgresBackend } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

registerFunction("pgRet", () => "done");
registerFunction("pgBump", (input) => {
  const raw = (input as { n?: unknown } | undefined)?.n;
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(n) ? n + 1 : 1;
});
registerFunction("pgFan", () => ({}));
const pgSideHits: string[] = [];
registerFunction("pgSide", () => {
  pgSideHits.push("S");
  return "S";
});

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

  it("keeps pending writes stored before their checkpoint once the window is exceeded", async () => {
    const schema = schemaName();
    const backend = await openPostgresBackend({
      connectionString: DB!,
      schema,
      retention: { maxCheckpoints: 1, maxInterruptPoints: 0, finishedTtl: null },
    });
    open.push(backend);
    schemas.push(schema);
    const put = backend.checkpointer as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown, versions: unknown): Promise<unknown>;
      putWrites(config: unknown, writes: [string, unknown][], taskId: string): Promise<void>;
    };
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    const cp = (id: string, parent?: string) =>
      put.put(
        { configurable: { thread_id: "gap", checkpoint_ns: "", ...(parent ? { checkpoint_id: parent } : {}) } },
        { ...base, id, channel_values: { n: id }, channel_versions: { n: id } },
        { source: "loop", step: 1, parents: {} },
        { n: id },
      );
    await cp("1");
    await cp("2", "1");
    await put.putWrites(
      { configurable: { thread_id: "gap", checkpoint_ns: "", checkpoint_id: "future" } },
      [["side", "S"], ["__interrupt__", { reason: "wait" }]],
      "task",
    );
    await cp("3", "2");
    const writes = await backend.pool.query<{ channel: string }>(
      `SELECT channel FROM "${schema}".checkpoint_writes WHERE thread_id = 'gap' AND checkpoint_id = 'future' ORDER BY channel`,
    );
    expect(writes.rows.map((row) => row.channel)).toEqual(["__interrupt__", "side"]);
  });

  it("a thread past the window still runs a parallel interrupt and its side effect once", async () => {
    const plain = await pgDrive(false, pgParallel(8), { n: 0 });
    const kept = await pgDrive({ maxCheckpoints: 3, maxInterruptPoints: 8, finishedTtl: null }, pgParallel(8), { n: 0 });
    expect(kept).toEqual(plain);
    expect(plain.hits).toEqual(["S"]);
    expect(plain.status).toBe("completed");
  });

  it("a thread past the window resumes a map interrupt the same way as retention off", async () => {
    const input = { n: 0, numbers: [1, 2] };
    const plain = await pgDrive(false, pgMap(8), input);
    const kept = await pgDrive({ maxCheckpoints: 3, maxInterruptPoints: 8, finishedTtl: null }, pgMap(8), input);
    expect(kept).toEqual(plain);
    expect(plain.status).toBe("completed");
    expect(plain.out).toHaveLength(2);
  });

  it("map interrupts with maxCheckpoints 1 match retention off", async () => {
    const input = { numbers: [1, 2] };
    const plain = await pgDrive(false, pgMap(0), input);
    const kept = await pgDrive({ maxCheckpoints: 1, maxInterruptPoints: 8, finishedTtl: null }, pgMap(0), input);
    expect(kept).toEqual(plain);
    expect(plain.status).toBe("completed");
  });

  it("deleteThread removes a parked thread with retention on and off", async () => {
    for (const retention of [{ maxFinishedThreads: 0, finishedTtl: null } as const, false as const]) {
      const schema = schemaName();
      const backend = await openPostgresBackend({ connectionString: DB!, schema, retention });
      open.push(backend);
      schemas.push(schema);
      const api = backend.checkpointer as unknown as {
        put(config: unknown, checkpoint: unknown, metadata: unknown, versions: unknown): Promise<unknown>;
        beginThreadRun(threadId: string): number;
        endThreadRun(threadId: string, status: "paused" | "finished", token?: number): void;
        deleteThread(threadId: string): Promise<void>;
      };
      const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
      await api.put(
        { configurable: { thread_id: "parked", checkpoint_ns: "" } },
        { ...base, id: "1", channel_values: { n: 1 }, channel_versions: { n: "1" } },
        { source: "loop", step: 1, parents: {} },
        { n: "1" },
      );
      const token = api.beginThreadRun("parked");
      api.endThreadRun("parked", "paused", token);
      await api.deleteThread("parked");
      const left = await backend.pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM "${schema}".checkpoints WHERE thread_id = 'parked'`,
      );
      expect(Number(left.rows[0]?.n)).toBe(0);
    }
  });

  it("a second saver does not sweep a thread the first has marked active", async () => {
    const schema = schemaName();
    const retention = { maxFinishedThreads: 0, finishedTtl: null } as const;
    const writer = await openPostgresBackend({ connectionString: DB!, schema, retention });
    const sweeper = await openPostgresBackend({ connectionString: DB!, schema, retention, setup: false });
    open.push(writer, sweeper);
    schemas.push(schema);
    await writer.pool.query(
      `INSERT INTO "${schema}".fg_checkpoint_threads (thread_id, status, updated_at, deletable, finished_ttl_ms, max_finished)
       VALUES ('shared', 'finished', 1, 1, NULL, 0)`,
    );
    const put = writer.checkpointer as unknown as {
      put(config: unknown, checkpoint: unknown, metadata: unknown, versions: unknown): Promise<unknown>;
    };
    const base = { v: 4, ts: new Date().toISOString(), versions_seen: {} };
    let lost = 0;
    for (let i = 0; i < 30; i++) {
      const id = `c${i}`;
      await Promise.all([
        put.put(
          { configurable: { thread_id: "shared", checkpoint_ns: "" } },
          { ...base, id, channel_values: { n: i }, channel_versions: { n: String(i) } },
          { source: "loop", step: i, parents: {} },
          { n: String(i) },
        ),
        (sweeper.checkpointer as unknown as { sweep(now?: number): Promise<void> }).sweep(Date.now()),
      ]);
      const n = await writer.pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM "${schema}".checkpoints WHERE thread_id = 'shared' AND checkpoint_id = $1`,
        [id],
      );
      if (Number(n.rows[0]?.n) === 0) lost += 1;
    }
    expect(lost).toBe(0);
  });
});

function pgParallel(warm: number): GraphSpec {
  return {
    metadata: { name: "pg-parallel-side" },
    state: { channels: { n: { type: "number" }, sideOut: { type: "string" }, gate: { type: "object" } } },
    nodes: [
      { id: "bump", type: "function", with: { fn: "pgBump", input: { n: "{{ state.n }}" }, output: { to: "n" } } },
      { id: "fan", type: "function", with: { fn: "pgFan" } },
      { id: "effect", type: "function", with: { fn: "pgSide", output: { to: "sideOut" } } },
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

function pgMap(warm: number): GraphSpec {
  const bump = warm > 0
    ? [{ id: "bump", type: "function", with: { fn: "pgBump", input: { n: "{{ state.n }}" }, output: { to: "n" } } }]
    : [];
  return {
    metadata: { name: "pg-map-items" },
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

async function pgDrive(
  retention: false | { maxCheckpoints: number; maxInterruptPoints: number; finishedTtl: null },
  spec: GraphSpec,
  input: Record<string, unknown>,
) {
  const schema = schemaName();
  const backend = await openPostgresBackend({ connectionString: DB!, schema, retention });
  open.push(backend);
  schemas.push(schema);
  pgSideHits.length = 0;
  const compiled = await compileGraph(spec, { checkpointer: backend.checkpointer });
  const threadId = `live-${schema}`;
  let result = await compiled.run({ threadId, input, onInterrupt: "fail" });
  let resumes = 0;
  while (result.status === "interrupted" && resumes < 8) {
    resumes += 1;
    result = await compiled.resume({ threadId, resume: { approved: true }, onInterrupt: "fail" });
  }
  return { status: result.status, resumes, hits: [...pgSideHits], out: result.state["out"], gate: result.state["gate"], side: result.state["sideOut"] };
}
