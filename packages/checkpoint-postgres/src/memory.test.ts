import { describe, it, expect, afterAll, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { compileGraph, registerFunction, MEMORY_DEFAULT_LIMITS, type GraphSpec, type NodeRunContext, type MemoryIdentity } from "@flowgraph/core";
import { describeMemoryBackendConformance } from "@flowgraph/testing/memory-conformance";
import { openPostgresBackend, createPostgresMemoryBackend, migratePostgresMemorySchema, POSTGRES_MEMORY_MIGRATIONS, type PostgresBackend } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];
const here = path.dirname(fileURLToPath(import.meta.url));

// Every test gets its own schema, dropped afterwards, so runs never collide.
const schemas: string[] = [];
let admin: pg.Pool | undefined;
function freshSchema(): string {
  const s = `fgt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  schemas.push(s);
  return s;
}
afterAll(async () => {
  if (!admin) return;
  for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await admin.end();
});

const tu = (o: Partial<{ org: string; project: string; graph: string; usr: string; subjectType: string; subjectKey: string }> = {}) => ({
  org: "acme", project: "p", graph: "", usr: "", subjectType: "", subjectKey: "", ...o,
});

describe.skipIf(!DB)("postgres memory backend (integration)", () => {
  beforeAll(() => {
    admin = new pg.Pool({ connectionString: DB, max: 2 });
  });

  describeMemoryBackendConformance("postgres", async () => {
    const schema = freshSchema();
    let pool = new pg.Pool({ connectionString: DB, max: 8 });
    return {
      backend: await createPostgresMemoryBackend(pool, { schema }),
      async reopen() {
        await pool.end();
        pool = new pg.Pool({ connectionString: DB, max: 8 });
        return createPostgresMemoryBackend(pool, { schema });
      },
      async cleanup() {
        await pool.end();
      },
    };
  });

  async function open(schema = freshSchema()): Promise<PostgresBackend> {
    return openPostgresBackend({ connectionString: DB!, schema });
  }

  it("shares one pool with the checkpointer and migrates idempotently", async () => {
    const schema = freshSchema();
    await (await open(schema)).close();
    const b = await open(schema);
    try {
      const tables = (
        await b.pool.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1`, [schema])
      ).rows.map((r) => r.t);
      expect(tables).toEqual(
        expect.arrayContaining(["fg_memory_items", "fg_memory_ops", "fg_memory_threads", "fg_memory_meta", "fg_schema_migrations", "checkpoints"]),
      );
      const n = await b.pool.query(`SELECT COUNT(*)::int AS n FROM "${schema}".fg_schema_migrations WHERE component = 'memory'`);
      expect(n.rows[0]).toEqual({ n: 3 });
      expect(b.memory.durable).toBe(true);
      expect(b.memory.kind).toBe("postgres");
    } finally {
      await b.close();
    }
  });

  it("concurrent starts run each migration once", async () => {
    const schema = freshSchema();
    const pools = Array.from({ length: 6 }, () => new pg.Pool({ connectionString: DB, max: 1 }));
    try {
      const applied = await Promise.all(pools.map((p) => migratePostgresMemorySchema(p, schema)));
      expect(applied.reduce((a, b) => a + b, 0)).toBe(3);
      expect(applied.filter((n) => n === 3)).toHaveLength(1);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it("concurrent cold opens all succeed, on a fresh database and a fresh named schema", async () => {
    const adminClient = new pg.Client({ connectionString: DB });
    await adminClient.connect();
    try {
      for (let round = 0; round < 3; round++) {
        // Default schema of a brand-new database.
        const name = `fgt_cold_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        await adminClient.query(`CREATE DATABASE ${name}`);
        const url = new URL(DB!);
        url.pathname = `/${name}`;
        try {
          const opened = await Promise.allSettled(
            Array.from({ length: 8 }, () => openPostgresBackend({ connectionString: url.toString(), poolConfig: { max: 1 } })),
          );
          for (const r of opened) if (r.status === "fulfilled") await r.value.close();
          expect(opened.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
        } finally {
          await adminClient.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        }
        // A named schema that does not exist yet.
        const schema = freshSchema();
        const opened = await Promise.allSettled(
          Array.from({ length: 8 }, () => openPostgresBackend({ connectionString: DB!, schema, poolConfig: { max: 1 } })),
        );
        for (const r of opened) if (r.status === "fulfilled") await r.value.close();
        expect(opened.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      }
    } finally {
      await adminClient.end();
    }
  }, 120_000);

  it("gives up waiting for the setup lock after setupLockTimeoutMs with a clear error", async () => {
    const schema = freshSchema();
    const holder = new pg.Client({ connectionString: DB });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`flowgraph:setup:${schema}`]);
      const t0 = Date.now();
      const err = await openPostgresBackend({ connectionString: DB!, schema, setupLockTimeoutMs: 400 }).then(
        (b) => (void b.close(), undefined),
        (e: unknown) => e as Error & { code?: string },
      );
      const waited = Date.now() - t0;
      expect(err?.code).toBe("FLOWGRAPH_SETUP_LOCK_TIMEOUT");
      expect(err?.message).toMatch(new RegExp(`timed out after 400ms waiting for the schema setup lock on "${schema}"`));
      expect(waited).toBeGreaterThanOrEqual(380);
      expect(waited).toBeLessThan(5_000);
      // Once the holder lets go, opening works.
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`flowgraph:setup:${schema}`]);
      const b = await openPostgresBackend({ connectionString: DB!, schema, setupLockTimeoutMs: 400 });
      await b.close();
    } finally {
      await holder.end();
    }
  }, 30_000);

  it("writes stay correct when the session default isolation is repeatable read", async () => {
    const schema = freshSchema();
    const pool = new pg.Pool({ connectionString: DB, max: 8, options: "-c default_transaction_isolation=repeatable\\ read" });
    try {
      expect((await pool.query("SHOW default_transaction_isolation")).rows[0]).toEqual({ default_transaction_isolation: "repeatable read" });
      const memory = await createPostgresMemoryBackend(pool, { schema });
      const t = tu({ project: "p", graph: "g" });
      const results = await Promise.allSettled(
        Array.from({ length: 60 }, (_, i) =>
          memory.write({ kind: "increment", tuple: i % 2 ? t : tu({ project: "p" }), key: "hits", field: "n", limits: MEMORY_DEFAULT_LIMITS }),
        ),
      );
      expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      expect((await memory.get(t, "hits"))?.value).toEqual({ n: 30 });
      expect((await memory.get(tu({ project: "p" }), "hits"))?.value).toEqual({ n: 30 });
    } finally {
      await pool.end();
    }
  });

  it("an idle connection the server terminates is reported, not a crash", async () => {
    const app = `fgt_idle_${randomUUID().slice(0, 8)}`;
    const errors: Array<{ code?: string }> = [];
    const b = await openPostgresBackend({
      connectionString: DB!,
      schema: freshSchema(),
      poolConfig: { max: 2, application_name: app },
      onPoolError: (err) => errors.push(err as { code?: string }),
    });
    try {
      await b.pool.query("SELECT 1");
      const killed = await admin!.query<{ ok: boolean }>(
        "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
        [app],
      );
      expect(killed.rows.length).toBeGreaterThan(0);
      const deadline = Date.now() + 5_000;
      while (errors.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(errors[0]?.code).toBe("57P01");
      // The pool replaces the connection.
      expect((await b.pool.query("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
      await b.memory.write({ kind: "put", tuple: tu(), key: "after", value: 1, limits: MEMORY_DEFAULT_LIMITS });
    } finally {
      await b.close();
    }
  });

  it("does not end a pool it was given", async () => {
    const pool = new pg.Pool({ connectionString: DB, max: 2 });
    const b = await openPostgresBackend({ pool, schema: freshSchema() });
    await b.close();
    expect((await pool.query("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
    await pool.end();
  });

  it("a fresh schema never builds the index migration 3 drops; an older one loses it", async () => {
    const indexes = async (schema: string) =>
      (await admin!.query<{ n: string }>(`SELECT indexname AS n FROM pg_indexes WHERE schemaname = $1`, [schema])).rows.map((r) => r.n);
    const fresh = freshSchema();
    await migratePostgresMemorySchema(admin!, fresh);
    expect(await indexes(fresh)).toContain("fg_memory_subject_keys");
    expect(await indexes(fresh)).not.toContain("fg_memory_subject_recent");
    // A schema an earlier build migrated to version 1 still has the old index.
    const old = freshSchema();
    await admin!.query(`CREATE SCHEMA "${old}"`);
    await admin!.query(`CREATE TABLE "${old}".fg_schema_migrations (component TEXT NOT NULL, version INTEGER NOT NULL, applied_at BIGINT NOT NULL, PRIMARY KEY (component, version))`);
    await admin!.query(POSTGRES_MEMORY_MIGRATIONS[0]!.sql.replaceAll("{s}", `"${old}"`));
    await admin!.query(
      `CREATE INDEX fg_memory_subject_recent ON "${old}".fg_memory_items (org, project, subject_type, updated_at DESC) WHERE subject_type <> ''`,
    );
    await admin!.query(`INSERT INTO "${old}".fg_schema_migrations VALUES ('memory', 1, 0)`);
    expect(await migratePostgresMemorySchema(admin!, old)).toBe(2);
    expect(await indexes(old)).toContain("fg_memory_subject_keys");
    expect(await indexes(old)).not.toContain("fg_memory_subject_recent");
  });

  it("refuses a schema migrated by a newer flowgraph", async () => {
    const schema = freshSchema();
    const b = await open(schema);
    await b.pool.query(`INSERT INTO "${schema}".fg_schema_migrations VALUES ('memory', 99, 0)`);
    await b.close();
    await expect(open(schema)).rejects.toThrow(/newer than this flowgraph supports/);
  });

  it("rejects an invalid schema name", async () => {
    await expect(openPostgresBackend({ connectionString: DB!, schema: 'x"; drop' })).rejects.toThrow(/invalid postgres schema/);
  });

  it("the DDL rejects malformed scope tuples even outside the engine", async () => {
    const schema = freshSchema();
    const b = await open(schema);
    try {
      const ins = (...v: string[]) =>
        b.pool.query(
          `INSERT INTO "${schema}".fg_memory_items (org, project, graph, usr, subject_type, subject_key, key, value, bytes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'k', '1', 1, 0, 0)`,
          v,
        );
      await expect(ins("o", "", "g", "", "", "")).rejects.toThrow(/check constraint/);
      await expect(ins("o", "p", "g", "", "incident", "x")).rejects.toThrow(/check constraint/);
      await expect(ins("o", "p", "", "", "incident", "")).rejects.toThrow(/check constraint/);
      await expect(ins("", "p", "", "", "", "")).rejects.toThrow(/check constraint/);
    } finally {
      await b.close();
    }
  });

  it("the subject cap and cross-subject search can use the covering subject index", async () => {
    const schema = freshSchema();
    const b = await open(schema);
    const c = await b.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL enable_seqscan = off");
      const plan = async (sql: string, params: unknown[]) =>
        (await c.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");
      const cap = await plan(
        `SELECT subject_key AS k, MAX(updated_at) AS last FROM "${schema}".fg_memory_items
          WHERE org = $1 AND project = $2 AND subject_type = $3 AND subject_type <> '' AND subject_key <> $4
            AND (expires_at IS NULL OR expires_at > $5)
          GROUP BY subject_key ORDER BY last DESC, k DESC OFFSET $6`,
        ["o", "p", "t", "k", 0, 1],
      );
      expect(cap).toMatch(/Index Only Scan (Backward )?using fg_memory_subject_keys/);
      // Capture the cross-subject query the backend actually runs.
      let similar: { sql: string; params: unknown[] } | undefined;
      const orig = b.pool.query.bind(b.pool);
      (b.pool as { query: unknown }).query = (sql: string, params: unknown[]) => {
        if (typeof sql === "string" && sql.startsWith("WITH s AS")) similar = { sql, params };
        return orig(sql, params);
      };
      try {
        await b.memory.similarSubjects({ org: "o", project: "p", subjectType: "t", limit: 5, perSubject: 2 });
      } finally {
        (b.pool as { query: unknown }).query = orig;
      }
      const sp = await plan(similar!.sql, similar!.params);
      expect(sp).toMatch(/Index Only Scan (Backward )?using fg_memory_subject_keys on fg_memory_items f/);
      expect(sp).toMatch(/Index Scan (Backward )?using fg_memory_subject_keys on fg_memory_items i/);
      expect(sp).not.toMatch(/Seq Scan/);
      await c.query("ROLLBACK");
    } finally {
      c.release();
      await b.close();
    }
  });

  it("the sweeper removes expired items and old op records, and claims each interval once", async () => {
    const b = await open();
    try {
      const t = tu();
      await b.memory.write({ kind: "put", tuple: t, key: "gone", value: 1, ttlMs: 10, now: 1_000, limits: MEMORY_DEFAULT_LIMITS });
      await b.memory.write({ kind: "put", tuple: t, key: "kept", value: 2, opId: "op-1", now: 1_000, limits: MEMORY_DEFAULT_LIMITS });
      const { maybeSweepPostgres } = await import("./index.js");
      // open() already swept at the wall clock; the next interval starts an hour later.
      const now = Date.now() + 2 * 3_600_000;
      const results = await Promise.all([1, 2, 3].map(() => maybeSweepPostgres(b.memory, 60_000, now)));
      expect(results.reduce((a, x) => a + x, 0)).toBe(1);
      expect(await maybeSweepPostgres(b.memory, 60_000, now + 1)).toBe(0);
      expect((await b.memory.get(t, "kept", now))?.value).toBe(2);
      const ops = await b.pool.query(`SELECT COUNT(*)::int AS n FROM "${b.memory.schema}".fg_memory_ops`);
      expect(ops.rows[0]).toEqual({ n: 0 });
    } finally {
      await b.close();
    }
  });

  it("no increments are lost across concurrent processes", async () => {
    const schema = freshSchema();
    await (await open(schema)).close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-pgmem-"));
    const script = path.join(dir, "inc.mjs");
    const dist = path.resolve(here, "../dist/index.js");
    fs.writeFileSync(
      script,
      `import { openPostgresBackend } from ${JSON.stringify(dist)};
const MEMORY_DEFAULT_LIMITS = ${JSON.stringify(MEMORY_DEFAULT_LIMITS)};
const b = await openPostgresBackend({ connectionString: process.argv[2], schema: process.argv[3] });
const t = { org: "acme", project: "p", graph: "", usr: "", subjectType: "", subjectKey: "" };
await Promise.all([0, 1].map(async (lane) => {
  for (let i = 0; i < 15; i++) {
    await b.memory.write({ kind: "increment", tuple: t, key: "hits", field: "n", limits: MEMORY_DEFAULT_LIMITS });
    await b.memory.write({ kind: "append", tuple: t, key: "log", value: process.pid + ":" + lane + ":" + i, max: 1000, limits: MEMORY_DEFAULT_LIMITS });
    await b.memory.write({ kind: "increment", tuple: t, key: "once", field: "n", opId: "shared-" + i, limits: MEMORY_DEFAULT_LIMITS });
  }
}));
await b.close();
`,
    );
    const runOne = () =>
      new Promise<void>((resolve, reject) => {
        const c = spawn(process.execPath, [script, DB!, schema], { cwd: here, stdio: ["ignore", "inherit", "pipe"] });
        let err = "";
        c.stderr.on("data", (d) => (err += String(d)));
        c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
      });
    try {
      await Promise.all([runOne(), runOne(), runOne(), runOne()]);
      const b = await open(schema);
      try {
        const t = tu();
        expect((await b.memory.get(t, "hits"))?.value).toEqual({ n: 120 });
        expect(((await b.memory.get(t, "log"))?.value as unknown[]).length).toBe(120);
        // Same op id from every process and lane: applied once each.
        expect((await b.memory.get(t, "once"))?.value).toEqual({ n: 15 });
      } finally {
        await b.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── graph-level integration ─────────────────────────────────────────────────

const identity: MemoryIdentity = { org: "acme", project: "github.com/acme/web", user: "dev@acme.test" };

describe.skipIf(!DB)("runtime.memory on postgres (graph integration)", () => {
  beforeAll(() => {
    admin ??= new pg.Pool({ connectionString: DB, max: 2 });
    registerFunction("pgMemBump", async (_i, ctx: NodeRunContext) => {
      const g = await ctx.memory!.increment("graph", "runs", "n");
      return { graph: g.value, scope: ctx.memory!.scope };
    });
    registerFunction("pgBumpThenAsk", async (_i, ctx: NodeRunContext) => {
      const r = await ctx.memory!.increment("graph", "replayed", "n");
      const answer = ctx.interrupt<string>({ reason: "continue?" });
      return { n: (r.value as { n: number }).n, answer, scope: ctx.memory!.scope };
    });
  });

  function fnGraph(name: string, fn: string, memory: Record<string, unknown> = {}): GraphSpec {
    return {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name },
      state: { channels: { out: { type: "object" } } },
      nodes: [{ id: "n", type: "function", with: { fn, output: { to: "out" } } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
      runtime: { checkpoint: { backend: "postgres" }, memory },
    } as unknown as GraphSpec;
  }

  it("ctx.memory survives a restart and counts every run", async () => {
    const schema = freshSchema();
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) {
      const b = await openPostgresBackend({ connectionString: DB!, schema });
      const compiled = await compileGraph(fnGraph("counter", "pgMemBump"), { checkpointer: b.checkpointer, memory: { backend: b.memory, identity } });
      const r = await compiled.run({ threadId: `t-${i}`, onInterrupt: "fail" });
      expect(r.status).toBe("completed");
      last = r.state;
      await b.close();
    }
    expect(last["out"]).toMatchObject({ graph: { n: 3 } });
  });

  it("resume on a new pool reuses the thread's binding and does not double-apply writes", async () => {
    const schema = freshSchema();
    const spec = fnGraph("replay", "pgBumpThenAsk", { subject: { type: "ticket", key: "{{ input.ticket }}" } });
    const a = await openPostgresBackend({ connectionString: DB!, schema });
    const first = await (await compileGraph(spec, { checkpointer: a.checkpointer, memory: { backend: a.memory, identity } })).run({
      threadId: "rt",
      input: { ticket: "T-1" },
      onInterrupt: "fail",
    });
    expect(first.status).toBe("interrupted");
    await a.close();
    const b = await openPostgresBackend({ connectionString: DB!, schema });
    try {
      const compiled = await compileGraph(spec, { checkpointer: b.checkpointer, memory: { backend: b.memory, identity } });
      const r = await compiled.resume({ threadId: "rt", resume: "yes", onInterrupt: "fail" });
      expect(r.status).toBe("completed");
      expect(r.state["out"]).toMatchObject({ n: 1, answer: "yes", scope: { subject: { type: "ticket", key: "T-1" } } });
      const t = tu({ project: "github.com/acme/web", graph: "replay" });
      expect((await b.memory.get(t, "replayed"))?.value).toEqual({ n: 1 });
    } finally {
      await b.close();
    }
  });
});
