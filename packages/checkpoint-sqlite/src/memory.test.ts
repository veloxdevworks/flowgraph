import { describe, it, expect, afterEach, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileGraph, registerFunction, MEMORY_DEFAULT_LIMITS, createScopedMemory, defaultMemoryPolicy, memoryPositionalOpId, type GraphSpec, type NodeRunContext, type MemoryIdentity } from "@flowgraph/core";
import { describeMemoryBackendConformance } from "@flowgraph/testing/memory-conformance";
import { openSqliteBackend, createSqliteMemoryBackend, type SqliteBackend } from "./index.js";
import { openDatabase } from "./memory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDirs: string[] = [];
const open: SqliteBackend[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-mem-"));
  tmpDirs.push(dir);
  return path.join(dir, "checkpoints.db");
}

async function backend(dbPath: string): Promise<SqliteBackend> {
  const b = await openSqliteBackend(dbPath);
  open.push(b);
  return b;
}

describeMemoryBackendConformance("sqlite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-memc-"));
  const file = path.join(dir, "m.db");
  let db = openDatabase(file);
  return {
    backend: createSqliteMemoryBackend(db),
    async reopen() {
      db.close();
      db = openDatabase(file);
      return createSqliteMemoryBackend(db);
    },
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe("sqlite memory backend", () => {
  it("shares one file with the checkpointer and migrates idempotently", async () => {
    const p = tmpDb();
    const a = await backend(p);
    a.close();
    const b = await backend(p);
    const tables = (b.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["fg_memory_items", "fg_memory_ops", "fg_memory_threads", "fg_schema_migrations", "fg_memory_meta"]));
    expect(tables).not.toContain("fg_threads");
    expect(tables).not.toContain("fg_meta");
    expect(b.db.prepare(`SELECT COUNT(*) AS n FROM fg_schema_migrations WHERE component='memory'`).get()).toEqual({ n: 3 });
    expect(b.db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  /** Roll a migrated file back to the v1 shape. */
  function rollBackToV1(db: SqliteBackend["db"]): void {
    db.exec(`
      DROP INDEX fg_memory_subject_keys;
      CREATE INDEX fg_memory_subject_recent ON fg_memory_items (org, project, subject_type, updated_at DESC) WHERE subject_type <> '';
      ALTER TABLE fg_memory_threads RENAME TO fg_threads;
      ALTER TABLE fg_memory_meta RENAME TO fg_meta;
      ALTER TABLE fg_memory_ops DROP COLUMN fingerprint;
      DELETE FROM fg_schema_migrations WHERE component = 'memory' AND version > 1;
    `);
  }

  it("migrations 2 and 3 upgrade an existing v1 database and keep its data", async () => {
    const p = tmpDb();
    const a = await backend(p);
    const t = { org: "acme", project: "p", graph: "g", usr: "", subjectType: "", subjectKey: "" };
    await a.memory.write({ kind: "put", tuple: t, key: "k", value: { v: 1 }, limits: MEMORY_DEFAULT_LIMITS });
    await a.memory.bindThread({ threadId: "t-old", org: "acme", project: "p", graph: "g", usr: "", subjectType: "", subjectKey: "" });
    rollBackToV1(a.db);
    a.close();
    const b = await backend(p);
    const cols = (b.db.prepare(`PRAGMA table_info(fg_memory_ops)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("fingerprint");
    expect(b.db.prepare(`SELECT COUNT(*) AS n FROM fg_schema_migrations WHERE component='memory'`).get()).toEqual({ n: 3 });
    expect((await b.memory.get(t, "k"))?.value).toEqual({ v: 1 });
    expect((await b.memory.getThread("t-old"))?.graph).toBe("g");
    const indexes = (b.db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain("fg_memory_subject_keys");
    expect(indexes).not.toContain("fg_memory_subject_recent");
  });

  it("a positional op row with a null fingerprint is applied again, then stable", async () => {
    const b = await backend(tmpDb());
    const binding = { org: "acme", project: "p", graph: "g", user: "u" };
    const source = { threadId: "t-old", checkpointNs: "", taskId: "task-old", nodeId: "n" };
    const tuple = { org: "acme", project: "p", graph: "g", usr: "", subjectType: "", subjectKey: "" };
    const id = memoryPositionalOpId(source, 0)!;
    await b.memory.write({ kind: "increment", tuple, key: "c", field: "n", by: 1, opId: id, limits: MEMORY_DEFAULT_LIMITS });
    b.db.prepare(`UPDATE fg_memory_ops SET fingerprint = NULL WHERE op_id = ?`).run(id);
    const again = await createScopedMemory(b.memory, binding, defaultMemoryPolicy(), source).increment("graph", "c", "n");
    expect(again.deduped).toBe(false);
    expect(again.value).toEqual({ n: 2 });
    const stable = await createScopedMemory(b.memory, binding, defaultMemoryPolicy(), source).increment("graph", "c", "n");
    expect(stable.deduped).toBe(true);
    expect(stable.value).toEqual({ n: 2 });
  });

  it("the subject cap and cross-subject search use the covering subject index", async () => {
    const b = await backend(tmpDb());
    const plan = (sql: string, ...params: unknown[]) =>
      (b.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail).join("\n");
    const cap = plan(
      `SELECT subject_key AS k, MAX(updated_at) AS last FROM fg_memory_items
       WHERE org = ? AND project = ? AND subject_type = ? AND subject_type <> ''
         AND subject_key <> ? AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY subject_key ORDER BY last DESC, k DESC LIMIT -1 OFFSET ?`,
      "o", "p", "t", "k", 0, 1,
    );
    expect(cap).toMatch(/COVERING INDEX fg_memory_subject_keys/);
    // Untagged cross-subject search: subjects from the covering index, then
    // rows of the chosen subjects only.
    const db = b.db;
    const prepare = db.prepare.bind(db);
    let similarPlan = "";
    db.prepare = ((sql: string) => {
      if (sql.startsWith("WITH s AS")) similarPlan = plan(sql, "o", "p", "t", "", 0, 5, "o", "p", "t", "", 0, 2);
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      await b.memory.similarSubjects({ org: "o", project: "p", subjectType: "t", limit: 5, perSubject: 2 });
    } finally {
      db.prepare = prepare as typeof db.prepare;
    }
    expect(similarPlan).toMatch(/SEARCH f USING COVERING INDEX fg_memory_subject_keys/);
    expect(similarPlan).toMatch(/SEARCH i USING INDEX fg_memory_subject_keys \(.*subject_key=\?\)/);
    expect(similarPlan).not.toMatch(/SCAN (f|i|fg_memory_items)\b/);
  });

  it("refuses a database migrated by a newer flowgraph", async () => {
    const p = tmpDb();
    const a = await backend(p);
    a.db.prepare(`INSERT INTO fg_schema_migrations VALUES ('memory', 99, 0)`).run();
    a.close();
    await expect(openSqliteBackend(p)).rejects.toThrow(/newer than this flowgraph supports/);
  });

  it("the DDL rejects malformed scope tuples even outside the engine", async () => {
    const b = await backend(tmpDb());
    const ins = b.db.prepare(`INSERT INTO fg_memory_items (org, project, graph, usr, subject_type, subject_key, key, value, bytes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'k', '1', 1, 0, 0)`);
    expect(() => ins.run("o", "", "g", "", "", "")).toThrow(/CHECK/);
    expect(() => ins.run("o", "p", "g", "", "incident", "x")).toThrow(/CHECK/);
    expect(() => ins.run("o", "p", "", "", "incident", "")).toThrow(/CHECK/);
  });

  it("no increments are lost across concurrent processes", async () => {
    const p = tmpDb();
    (await backend(p)).close();
    const script = path.join(path.dirname(p), "inc.mjs");
    const dist = path.resolve(here, "../dist/index.js");
    fs.writeFileSync(
      script,
      `import { openSqliteBackend } from ${JSON.stringify(dist)};
const MEMORY_DEFAULT_LIMITS = ${JSON.stringify(MEMORY_DEFAULT_LIMITS)};
const b = await openSqliteBackend(process.argv[2]);
const t = { org: "acme", project: "p", graph: "", usr: "", subjectType: "", subjectKey: "" };
for (let i = 0; i < 25; i++) {
  await b.memory.write({ kind: "increment", tuple: t, key: "hits", field: "n", limits: MEMORY_DEFAULT_LIMITS });
  await b.memory.write({ kind: "append", tuple: t, key: "log", value: process.pid + ":" + i, max: 1000, limits: MEMORY_DEFAULT_LIMITS });
}
b.close();
`,
    );
    const runOne = () =>
      new Promise<void>((resolve, reject) => {
        const c = spawn(process.execPath, [script, p], { cwd: here, stdio: ["ignore", "inherit", "pipe"] });
        let err = "";
        c.stderr.on("data", (d) => (err += String(d)));
        c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
      });
    await Promise.all([runOne(), runOne(), runOne(), runOne()]);
    const b = await backend(p);
    const t = { org: "acme", project: "p", graph: "", usr: "", subjectType: "", subjectKey: "" };
    expect((await b.memory.get(t, "hits"))?.value).toEqual({ n: 100 });
    expect(((await b.memory.get(t, "log"))?.value as unknown[]).length).toBe(100);
  }, 30_000);
});

// ── graph-level integration ─────────────────────────────────────────────────

const identity: MemoryIdentity = { org: "acme", project: "github.com/acme/web", user: "dev@acme.test" };

beforeAll(() => {
  registerFunction("memBump", async (_i, ctx: NodeRunContext) => {
    const g = await ctx.memory!.increment("graph", "runs", "n");
    const p = await ctx.memory!.increment("project", "runs", "n");
    return { graph: g.value, project: p.value, scope: ctx.memory!.scope };
  });
  registerFunction("memPutGraph", async (_i, ctx: NodeRunContext) => {
    await ctx.memory!.put("graph", "secret-plan", { v: ctx.meta.graph });
    await ctx.memory!.put("project", "shared", { v: ctx.meta.graph });
    return true;
  });
  registerFunction("memReadGraph", async (_i, ctx: NodeRunContext) => ({
    plan: (await ctx.memory!.get("secret-plan"))?.value ?? null,
    shared: (await ctx.memory!.get("shared"))?.value ?? null,
  }));
  registerFunction("legacyPut", async (_i, ctx: NodeRunContext) => {
    await ctx.store!.put(["facts"], "k", { from: ctx.meta.graph });
    return true;
  });
  registerFunction("legacyGet", async (_i, ctx: NodeRunContext) => ({
    item: (await ctx.store!.get(["facts"], "k"))?.value ?? null,
    all: (await ctx.store!.search(["facts"])).length,
    namespaces: await ctx.store!.listNamespaces(),
  }));
  registerFunction("subjectNote", async (_i, ctx: NodeRunContext) => {
    const r = await ctx.memory!.append("subject", "notes", ctx.meta.threadId);
    return { notes: r.value, scope: ctx.memory!.scope };
  });
  registerFunction("bumpThenAsk", async (_i, ctx: NodeRunContext) => {
    const r = await ctx.memory!.increment("graph", "replayed", "n");
    const answer = ctx.interrupt<string>({ reason: "continue?" });
    return { n: (r.value as { n: number }).n, answer, scope: ctx.memory!.scope };
  });
});

function fnGraph(name: string, fn: string, extraRuntime: Record<string, unknown> = { memory: {} }): GraphSpec {
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
    runtime: { checkpoint: { backend: "sqlite" }, ...extraRuntime },
  } as unknown as GraphSpec;
}

async function runOn(dbPath: string, spec: GraphSpec, opts: { threadId?: string; input?: Record<string, unknown> } = {}) {
  const b = await backend(dbPath);
  const compiled = await compileGraph(spec, { checkpointer: b.checkpointer, memory: { backend: b.memory, identity } });
  const r = await compiled.run({ threadId: opts.threadId ?? `t-${Math.random()}`, ...(opts.input ? { input: opts.input } : {}), onInterrupt: "fail" });
  b.close();
  return r;
}

describe("runtime.memory on sqlite (graph integration)", () => {
  it("ctx.memory survives a restart and counts every run", async () => {
    const p = tmpDb();
    for (let i = 0; i < 3; i++) {
      const r = await runOn(p, fnGraph("counter", "memBump"));
      expect(r.status).toBe("completed");
    }
    const r = await runOn(p, fnGraph("counter", "memBump"));
    expect(r.state["out"]).toMatchObject({ graph: { n: 4 }, project: { n: 4 } });
    expect((r.state["out"] as { scope: unknown }).scope).toEqual({ org: "acme", project: "github.com/acme/web", graph: "counter", user: "dev@acme.test" });
  });

  it("graph scope does not leak across graphs; project scope is shared", async () => {
    const p = tmpDb();
    await runOn(p, fnGraph("graph-a", "memPutGraph"));
    const b = await runOn(p, fnGraph("graph-b", "memReadGraph"));
    expect(b.state["out"]).toEqual({ plan: null, shared: { v: "graph-a" } });
    const a = await runOn(p, fnGraph("graph-a", "memReadGraph"));
    expect(a.state["out"]).toEqual({ plan: { v: "graph-a" }, shared: { v: "graph-a" } });
  });

  it("legacy ctx.store is durable and confined to its graph", async () => {
    const p = tmpDb();
    const noMem = { store: { backend: "sqlite" } };
    await runOn(p, fnGraph("legacy-a", "legacyPut", noMem));
    const other = await runOn(p, fnGraph("legacy-b", "legacyGet", noMem));
    expect(other.state["out"]).toEqual({ item: null, all: 0, namespaces: [] });
    const same = await runOn(p, fnGraph("legacy-a", "legacyGet", noMem));
    expect(same.state["out"]).toEqual({ item: { from: "legacy-a" }, all: 1, namespaces: [["facts"]] });
  });

  it("runtime.store.backend: sqlite is an alias for runtime.memory.backend: checkpoint", async () => {
    const p = tmpDb();
    const spec = fnGraph("alias", "memBump", { store: { backend: "sqlite" } });
    await runOn(p, spec);
    const r = await runOn(p, spec);
    expect(r.state["out"]).toMatchObject({ graph: { n: 2 } });
  });

  it("binds the subject from input; threads on the same subject share it", async () => {
    const p = tmpDb();
    const spec = fnGraph("triage", "subjectNote", {
      memory: { subject: { type: "incident", key: "{{ input.alert.fp }}", required: true } },
    });
    const r1 = await runOn(p, spec, { threadId: "t1", input: { alert: { fp: "inc-42" } } });
    const r2 = await runOn(p, spec, { threadId: "t2", input: { alert: { fp: "inc-42" } } });
    const r3 = await runOn(p, spec, { threadId: "t3", input: { alert: { fp: "inc-7" } } });
    expect(r1.state["out"]).toMatchObject({ notes: ["t1"] });
    expect(r2.state["out"]).toMatchObject({ notes: ["t1", "t2"], scope: { subject: { type: "incident", key: "inc-42" } } });
    expect(r3.state["out"]).toMatchObject({ notes: ["t3"] });
    const missing = await runOn(p, spec, { threadId: "t4", input: {} });
    expect(missing.status).toBe("error");
    expect(missing.error?.message).toMatch(/MEMORY_SUBJECT_UNRESOLVED/);
  });

  it("resume in a new process reuses the thread's binding and does not double-apply writes", async () => {
    const p = tmpDb();
    const spec = fnGraph("replay", "bumpThenAsk", {
      memory: { subject: { type: "ticket", key: "{{ input.ticket }}" } },
    });
    const first = await runOn(p, spec, { threadId: "rt", input: { ticket: "T-1" } });
    expect(first.status).toBe("interrupted");
    const b = await backend(p);
    const compiled = await compileGraph(spec, { checkpointer: b.checkpointer, memory: { backend: b.memory, identity } });
    const r = await compiled.resume({ threadId: "rt", resume: "yes", onInterrupt: "fail" });
    expect(r.status).toBe("completed");
    expect(r.state["out"]).toMatchObject({ n: 1, answer: "yes", scope: { subject: { type: "ticket", key: "T-1" } } });
    const t = { org: "acme", project: "github.com/acme/web", graph: "replay", usr: "", subjectType: "", subjectKey: "" };
    expect((await b.memory.get(t, "replayed"))?.value).toEqual({ n: 1 });
  });

  it("memory node writes and reads through YAML", async () => {
    const p = tmpDb();
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "yaml-mem" },
      state: { channels: { by: { type: "number" }, count: { type: "object" }, got: { type: "object" }, list: { type: "array" } } },
      nodes: [
        { id: "inc", type: "memory", with: { op: "increment", scope: "project", key: "deploys", field: "n", by: "{{ state.by }}", output: { to: "count" } } },
        { id: "put", type: "memory", with: { op: "put", scope: "graph", key: "last", value: { by: "{{ state.by }}" }, attrs: { kind: "deploy" } } },
        { id: "get", type: "memory", with: { op: "get", key: "last", output: { to: "got" } } },
        { id: "find", type: "memory", with: { op: "search", scopes: ["graph"], attrs: { kind: "deploy" }, output: { to: "list" } } },
      ],
      edges: [
        { from: "START", to: "inc" },
        { from: "inc", to: "put" },
        { from: "put", to: "get" },
        { from: "get", to: "find" },
        { from: "find", to: "END" },
      ],
      runtime: { checkpoint: { backend: "sqlite" }, memory: {} },
    } as unknown as GraphSpec;
    await runOn(p, spec, { input: { by: 2 } });
    const r = await runOn(p, spec, { input: { by: 3 } });
    expect(r.status).toBe("completed");
    expect(r.state["count"]).toMatchObject({ scope: "project", value: { n: 5 }, version: 2 });
    expect(r.state["got"]).toMatchObject({ scope: "graph", value: { by: 3 }, version: 2 });
    expect(r.state["list"]).toHaveLength(1);
  });
});
