import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerFunction } from "@flowgraph/core";
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
    expect(() => defaultServerConfig({ FLOWGRAPH_MEMORY_BACKEND: "redis" })).toThrow(/FLOWGRAPH_MEMORY_BACKEND must be one of/);
  });
});
