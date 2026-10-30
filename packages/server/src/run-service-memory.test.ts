import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_DEFAULT_LIMITS, registerFunction, type MemoryBackend } from "@flowgraph/core";
import { RunService } from "./run-service.js";
import { defaultServerConfig, type ServerConfig, type ServerMemoryConfig } from "./types.js";

const PG_URL = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

const COUNTER = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: hosted-counter }
state:
  channels:
    out: { type: object }
nodes:
  - { id: n, type: function, with: { fn: serverMemBump, output: { to: out } } }
edges:
  - { from: START, to: n }
  - { from: n, to: END }
runtime:
  checkpoint: { enabled: true, backend: postgres }
  memory: {}
`;

const seen: unknown[] = [];
beforeAll(() => {
  registerFunction("serverMemBump", async (_i, ctx) => {
    const r = await ctx.memory!.increment("project", "runs", "n");
    seen.push({ value: r.value, scope: ctx.memory!.scope });
    return r.value;
  });
});

const dirs: string[] = [];
const services: RunService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  seen.length = 0;
});

async function service(dir: string, memory: ServerMemoryConfig, databaseUrl?: string): Promise<RunService> {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    graphStoreDir: dir,
    eventBufferSize: 100,
    memory,
    ...(databaseUrl ? { databaseUrl } : {}),
  };
  const s = new RunService(config);
  await s.init();
  services.push(s);
  return s;
}

async function runToEnd(s: RunService, threadId: string): Promise<string | undefined> {
  await s.startRun({ threadId, yaml: COUNTER, input: {} });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const st = s.registry.get(threadId)?.status;
    if (st === "completed" || st === "error") return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  return s.registry.get(threadId)?.status;
}

const identity = { org: "acme", project: "acme/web", user: "svc@acme.test" };

describe("RunService durable memory", () => {
  it("defaults to process-local memory: a graph that declares runtime.memory fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-srvmem-"));
    dirs.push(dir);
    const s = await service(dir, { backend: "memory" });
    const err = await runToEnd(s, "t-default").then(() => undefined, (e: unknown) => e);
    expect(String(err)).toMatch(/MEMORY_BACKEND_UNAVAILABLE/);
    expect(String(err)).toMatch(/FLOWGRAPH_MEMORY_BACKEND=postgres/);
    expect(String(err)).not.toMatch(/flowgraph CLI|CompileOptions/);
  });

  it("sqlite memory survives a service restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-srvmem-"));
    dirs.push(dir);
    const a = await service(dir, { backend: "sqlite", identity });
    expect(await runToEnd(a, "t1")).toBe("completed");
    await a.close();
    services.splice(services.indexOf(a), 1);
    const b = await service(dir, { backend: "sqlite", identity });
    expect(await runToEnd(b, "t2")).toBe("completed");
    expect(seen.at(-1)).toEqual({ value: { n: 2 }, scope: { org: "acme", project: "acme/web", graph: "hosted-counter", user: "svc@acme.test" } });
    await expect(fs.stat(path.join(dir, "memory.db"))).resolves.toBeTruthy();
  });

  it("postgres memory needs DATABASE_URL", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-srvmem-"));
    dirs.push(dir);
    const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 10, memory: { backend: "postgres", identity } });
    await expect(s.init()).rejects.toThrow(/needs DATABASE_URL/);
  });

  it("durable memory refuses to start without FLOWGRAPH_ORG", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-srvmem-"));
    dirs.push(dir);
    for (const backend of ["sqlite", "postgres"] as const) {
      expect(
        () => new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 10, memory: { backend } }),
      ).toThrow(new RegExp(`FLOWGRAPH_MEMORY_BACKEND=${backend} needs FLOWGRAPH_ORG`));
    }
    await expect(fs.stat(path.join(dir, "memory.db"))).rejects.toThrow();
    // The default process-local mode needs no identity.
    expect(() => new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 10, memory: { backend: "memory" } })).not.toThrow();
    expect(() => new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 10 })).not.toThrow();
  });

  it.skipIf(!PG_URL)("postgres memory shares the checkpoint database and survives a restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-srvmem-"));
    dirs.push(dir);
    // Unique project so runs against a shared test database never collide.
    const id = { ...identity, project: `acme/web-${randomUUID()}` };
    const a = await service(dir, { backend: "postgres", identity: id }, PG_URL);
    expect(await runToEnd(a, `pg-${randomUUID()}`)).toBe("completed");
    await a.close();
    services.splice(services.indexOf(a), 1);
    const b = await service(dir, { backend: "postgres", identity: id }, PG_URL);
    expect(await runToEnd(b, `pg-${randomUUID()}`)).toBe("completed");
    expect((seen.at(-1) as { value: unknown }).value).toEqual({ n: 2 });
  });

  it.skipIf(!PG_URL)("on postgres, one replica sweeps each interval", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-srvmem-"));
    dirs.push(dir);
    const id = { ...identity, project: `acme/sweep-${randomUUID()}` };
    const a = await service(dir, { backend: "postgres", identity: id }, PG_URL);
    const b = await service(dir, { backend: "postgres", identity: id }, PG_URL);
    type Internals = { durableMemory: { backend: MemoryBackend }; sweeper: { sweepNow(): Promise<number> } };
    const ia = a as unknown as Internals;
    const ib = b as unknown as Internals;
    const tuple = { org: id.org, project: id.project, graph: "g", usr: "", subjectType: "", subjectKey: "" };
    await ia.durableMemory.backend.write({ kind: "put", tuple, key: "old", value: 1, ttlMs: 1, now: Date.now() - 60_000, limits: MEMORY_DEFAULT_LIMITS });
    const db = (ia.durableMemory.backend as unknown as { pool: { query(sql: string, args?: unknown[]): Promise<{ rows: unknown[] }> } }).pool;
    // Pretend the last claimed sweep was long ago.
    await db.query(`UPDATE public.fg_memory_meta SET value = '0' WHERE key = 'memory.last_sweep'`);
    const removed = await Promise.all([ia.sweeper.sweepNow(), ib.sweeper.sweepNow()]);
    expect(removed.filter((n) => n > 0)).toHaveLength(1);
    const count = async () =>
      (await db.query(`SELECT COUNT(*)::int AS n FROM public.fg_memory_items WHERE project = $1`, [id.project])).rows[0];
    expect(await count()).toEqual({ n: 0 });
    // This interval is claimed: neither replica sweeps again until it passes.
    await ia.durableMemory.backend.write({ kind: "put", tuple, key: "old2", value: 1, ttlMs: 1, now: Date.now() - 60_000, limits: MEMORY_DEFAULT_LIMITS });
    expect(await Promise.all([ia.sweeper.sweepNow(), ib.sweeper.sweepNow()])).toEqual([0, 0]);
    expect(await count()).toEqual({ n: 1 });
  });
});

describe("defaultServerConfig memory", () => {
  it("reads the memory backend, sqlite path, identity and sweep interval from env", () => {
    expect(defaultServerConfig({}).memory).toEqual({ backend: "memory" });
    expect(
      defaultServerConfig({
        FLOWGRAPH_MEMORY_BACKEND: "SQLite",
        FLOWGRAPH_MEMORY_SQLITE_PATH: "/data/mem.db",
        FLOWGRAPH_ORG: "acme",
        FLOWGRAPH_PROJECT: "acme/web",
        FLOWGRAPH_USER: "svc",
        FLOWGRAPH_MEMORY_SWEEP_MS: "60000",
      }).memory,
    ).toEqual({ backend: "sqlite", sqlitePath: "/data/mem.db", identity: { org: "acme", project: "acme/web", user: "svc" }, sweepIntervalMs: 60_000 });
    // FLOWGRAPH_PROJECT alone sets no identity; the org is what durable memory needs.
    expect(defaultServerConfig({ FLOWGRAPH_MEMORY_BACKEND: "postgres", FLOWGRAPH_PROJECT: "acme/web" }).memory).toEqual({ backend: "postgres" });
    expect(defaultServerConfig({ FLOWGRAPH_ORG: "acme" }).memory).toEqual({ backend: "memory", identity: { org: "acme", project: "local" } });
    for (const bad of ["abc", "-5", "0", "999", "1.5", "1e9", "60s"]) {
      expect(() => defaultServerConfig({ FLOWGRAPH_MEMORY_SWEEP_MS: bad }), bad).toThrow(/FLOWGRAPH_MEMORY_SWEEP_MS must be a whole number/);
    }
    expect(defaultServerConfig({ FLOWGRAPH_MEMORY_SWEEP_MS: " " }).memory).toEqual({ backend: "memory" });
    expect(() => defaultServerConfig({ FLOWGRAPH_MEMORY_BACKEND: "redis" })).toThrow(/FLOWGRAPH_MEMORY_BACKEND must be one of/);
  });
});
