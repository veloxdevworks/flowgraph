import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerFunction } from "@flowgraph/core";
import { RunService } from "./run-service.js";
import type { Principal, ServerAuthConfig } from "./identity.js";
import type { ServerConfig, ServerMemoryConfig } from "./types.js";

const PG_URL = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

const OIDC: ServerAuthConfig = {
  mode: "oidc",
  explicit: true,
  insecureDev: false,
  oidc: {
    issuer: "https://id.example.com",
    audience: ["api"],
    algorithms: ["RS256"],
    clockToleranceSec: 60,
    claims: { org: "org_id", roles: "roles", teams: "groups", displayName: ["name"] },
    trust: { roles: [], teams: [] },
    defaultProject: "local",
  },
};

function who(subject: string, org = "acme"): Principal {
  return {
    id: `https://id.example.com|${subject}`,
    subject,
    issuer: "https://id.example.com",
    org,
    project: "web",
    teams: [],
    roles: [],
    trusted: true,
    via: "oidc",
  };
}
const alice = who("alice");
const bob = who("bob");
const carol = who("carol", "globex");

const gate = (name: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    approval: { type: object }
nodes:
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
  hitl: { onInterrupt: fail }
`;

const COUNTER = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: id-counter }
state:
  channels:
    out: { type: object }
nodes:
  - { id: n, type: function, with: { fn: identityMemBump, output: { to: out } } }
edges:
  - { from: START, to: n }
  - { from: n, to: END }
runtime:
  checkpoint: { enabled: true, backend: sqlite }
  memory: {}
`;

const scopes: unknown[] = [];
beforeAll(() => {
  registerFunction("identityMemBump", async (_i, ctx) => {
    const r = await ctx.memory!.increment("user", "runs", "n");
    scopes.push({ value: r.value, scope: ctx.memory!.scope });
    return r.value;
  });
});

const dirs: string[] = [];
const services: RunService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  scopes.length = 0;
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "fg-srvid-"));
  dirs.push(d);
  return d;
}

async function service(dir: string, extra: Partial<ServerConfig> = {}): Promise<RunService> {
  const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100, auth: OIDC, ...extra });
  await s.init();
  services.push(s);
  return s;
}

async function settle(s: RunService, threadId: string, want: string[]): Promise<string | undefined> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const st = s.registry.get(threadId)?.status;
    if (st && want.includes(st)) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  return s.registry.get(threadId)?.status;
}

const refused = (code: string, status: number) => expect.objectContaining({ code, status });

describe("RunService with OIDC principals", () => {
  it("needs a principal for every call", async () => {
    const s = await service(await tmp());
    await expect(s.startRun({ threadId: "t", yaml: gate("g") })).rejects.toEqual(refused("AUTH_REQUIRED", 401));
    await expect(s.listRuns()).rejects.toEqual(refused("AUTH_REQUIRED", 401));
  });

  it("only the principal that started a thread can resume, read or control it", async () => {
    const s = await service(await tmp());
    const t = `own-${randomUUID()}`;
    await s.startRun({ threadId: t, yaml: gate("owned-gate"), input: {} }, alice);
    expect(await settle(s, t, ["interrupted", "error"])).toBe("interrupted");

    const notOwned = refused("THREAD_NOT_OWNED", 403);
    await expect(s.resumeRun({ threadId: t, resume: { approved: true } }, bob)).rejects.toEqual(notOwned);
    await expect(s.startRun({ threadId: t, yaml: gate("bobs-gate") }, bob)).rejects.toEqual(notOwned);
    await expect(s.getState(t, undefined, bob)).rejects.toEqual(notOwned);
    await expect(s.getHistory(t, undefined, bob)).rejects.toEqual(notOwned);
    await expect(s.getRun(t, bob)).rejects.toEqual(notOwned);
    await expect(s.getJournal(t, bob)).rejects.toEqual(notOwned);
    await expect(s.listIssues(t, bob)).rejects.toEqual(notOwned);
    await expect(s.authorizeEvents(t, bob)).rejects.toEqual(notOwned);
    await expect(s.cancelRun(t, bob)).rejects.toEqual(notOwned);
    await expect(s.pauseRun(t, bob)).rejects.toEqual(notOwned);
    await expect(s.continueRun(t, undefined, carol)).rejects.toEqual(notOwned);
    expect((await s.listRuns(bob)).map((r) => r.threadId)).not.toContain(t);
    expect((await s.listRuns(alice)).map((r) => r.threadId)).toContain(t);
    await expect(s.authorizeEvents(`missing-${randomUUID()}`, bob)).rejects.toEqual(refused("THREAD_NOT_FOUND", 404));
    await expect(s.resumeRun({ threadId: `missing-${randomUUID()}`, resume: {} }, bob)).rejects.toEqual(refused("THREAD_NOT_FOUND", 404));

    await s.resumeRun({ threadId: t, resume: { approved: true } }, alice);
    expect(await settle(s, t, ["completed", "error"])).toBe("completed");
    expect((await s.getRun(t, alice))?.status).toBe("completed");
  });

  it("refuses a stored thread that has no recorded owner", async () => {
    const dir = await tmp();
    const single = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 10 });
    services.push(single);
    await single.init();
    await single.startRun({ threadId: "legacy", yaml: gate("legacy-gate") });
    expect(await settle(single, "legacy", ["interrupted", "error"])).toBe("interrupted");
    const s = await service(dir);
    await expect(s.getState("legacy", undefined, alice)).rejects.toEqual(refused("THREAD_NOT_OWNED", 403));
  });

  it("refuses thread ids that map to the same stored file", async () => {
    const s = await service(await tmp());
    await s.startRun({ threadId: "a/b", yaml: gate("collide") }, alice);
    await expect(s.startRun({ threadId: "a_b", yaml: gate("collide") }, alice)).rejects.toEqual(refused("THREAD_ID_CONFLICT", 409));
  });

  it("a graph name belongs to its first registrant within an org", async () => {
    const s = await service(await tmp());
    await s.startRun({ threadId: "a1", yaml: gate("team-flow") }, alice);
    await expect(s.startRun({ threadId: "b1", yaml: gate("team-flow") }, bob)).rejects.toEqual(refused("GRAPH_NAME_TAKEN", 409));
    // Another org has its own namespace; the owner can reuse the name on new threads.
    await s.startRun({ threadId: "c1", yaml: gate("team-flow") }, carol);
    await s.startRun({ threadId: "a2", yaml: gate("team-flow") }, alice);
    // A rename is fine.
    await s.startRun({ threadId: "b2", yaml: gate("bobs-flow") }, bob);
  });

  it("with sqlite memory, graph-name ownership survives a restart and memory is per principal", async () => {
    const dir = await tmp();
    const memory: ServerMemoryConfig = { backend: "sqlite" };
    const a = await service(dir, { memory });
    await a.startRun({ threadId: "m1", yaml: COUNTER }, alice);
    expect(await settle(a, "m1", ["completed", "error"])).toBe("completed");
    await a.startRun({ threadId: "m2", yaml: COUNTER }, alice);
    expect(await settle(a, "m2", ["completed", "error"])).toBe("completed");
    expect(scopes.at(-1)).toEqual({ value: { n: 2 }, scope: { org: "acme", project: "web", graph: "id-counter", user: "alice" } });
    await a.close();
    services.splice(services.indexOf(a), 1);

    const b = await service(dir, { memory });
    await expect(b.startRun({ threadId: "m3", yaml: COUNTER }, bob)).rejects.toEqual(refused("GRAPH_NAME_TAKEN", 409));
    // Carol's org starts from zero.
    await b.startRun({ threadId: "m4", yaml: COUNTER }, carol);
    expect(await settle(b, "m4", ["completed", "error"])).toBe("completed");
    expect(scopes.at(-1)).toEqual({ value: { n: 1 }, scope: { org: "globex", project: "web", graph: "id-counter", user: "carol" } });
  });

  it("admits no case or Unicode look-alike of another user's graph name", async () => {
    const s = await service(await tmp());
    await s.startRun({ threadId: "nm1", yaml: gate("team-flow") }, alice);
    // Upper case, full-width "t" and Cyrillic "е" are not kebab-case names.
    for (const lookalike of ["Team-Flow", "\uff54eam-flow", "t\u0435am-flow"]) {
      await expect(s.startRun({ threadId: `nm-${randomUUID()}`, yaml: gate(`"${lookalike}"`) }, bob)).rejects.toThrow(/name must be kebab-case/);
    }
    await expect(s.startRun({ threadId: `nm-${randomUUID()}`, yaml: gate("team-flow") }, bob)).rejects.toEqual(refused("GRAPH_NAME_TAKEN", 409));
  });

  it("memory refuses another principal on a bound thread even if the server record is gone", async () => {
    const dir = await tmp();
    const memory: ServerMemoryConfig = { backend: "sqlite" };
    const s = await service(dir, { memory });
    await s.startRun({ threadId: "bound", yaml: COUNTER }, alice);
    expect(await settle(s, "bound", ["completed", "error"])).toBe("completed");
    // Simulate a lost graph store: only the memory binding remains.
    for (const f of await fs.readdir(dir)) if (f.startsWith("bound.")) await fs.rm(path.join(dir, f));
    s.registry.remove("bound");
    const errors: string[] = [];
    const unsub = s.registry.subscribe("bound", (ev) => {
      if (ev.type === "run.error") errors.push(JSON.stringify(ev.data));
    });
    // The thread owner is stored with the checkpoints, so the server still refuses.
    const yaml = COUNTER.replace("name: id-counter", "name: id-counter-2");
    await expect(s.startRun({ threadId: "bound", yaml }, bob)).rejects.toEqual(refused("THREAD_NOT_OWNED", 403));
    // Lose the owner row too: the thread's saved checkpoints still refuse it.
    const { openSqliteBackend } = await import("@flowgraph/checkpoint-sqlite");
    const raw = await openSqliteBackend(path.join(dir, "memory.db"));
    raw.db.prepare("DELETE FROM fg_thread_owners").run();
    raw.close();
    await expect(s.startRun({ threadId: "bound", yaml }, bob)).rejects.toMatchObject({ code: "THREAD_NOT_OWNED", message: expect.stringMatching(/saved state/) });
    // And after a restart (in-memory checkpoints gone), a same-org principal
    // under a fresh name gets past the server checks; memory's own thread
    // binding refuses.
    await s.close();
    const s2 = await service(dir, { memory });
    const unsub2 = s2.registry.subscribe("bound", (ev) => {
      if (ev.type === "run.error") errors.push(JSON.stringify(ev.data));
    });
    await expect(s2.startRun({ threadId: "bound", yaml }, bob)).resolves.toMatchObject({ status: "started" });
    expect(await settle(s2, "bound", ["completed", "error"])).toBe("error");
    unsub2();
    unsub();
    expect(errors.join("\n")).toMatch(/MEMORY_SCOPE_MISMATCH|bound to a different/);
  });

  it.skipIf(!PG_URL)("with postgres memory, graph-name ownership is shared by replicas", async () => {
    const dir = await tmp();
    const memory: ServerMemoryConfig = { backend: "postgres" };
    const name = `pg-flow-${randomUUID()}`;
    const a = await service(dir, { memory, databaseUrl: PG_URL! });
    const b = await service(await tmp(), { memory, databaseUrl: PG_URL! });
    const pa = `pa-${randomUUID()}`;
    const pc = `pc-${randomUUID()}`;
    await a.startRun({ threadId: pa, yaml: gate(name) }, alice);
    await expect(b.startRun({ threadId: `pb-${randomUUID()}`, yaml: gate(name) }, bob)).rejects.toEqual(refused("GRAPH_NAME_TAKEN", 409));
    await b.startRun({ threadId: pc, yaml: gate(name) }, alice);
    // Let both runs checkpoint before the services close their pools.
    expect(await settle(a, pa, ["interrupted", "error"])).toBe("interrupted");
    expect(await settle(b, pc, ["interrupted", "error"])).toBe("interrupted");
  });
});

describe("RunService in single-user mode", () => {
  it("keeps working without principals and ignores graph-name ownership", async () => {
    const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: await tmp(), eventBufferSize: 10, authToken: "t" });
    services.push(s);
    await s.init();
    await s.startRun({ threadId: "s1", yaml: gate("solo") });
    await s.startRun({ threadId: "s2", yaml: gate("solo") });
    expect((await s.listRuns()).map((r) => r.threadId).sort()).toEqual(["s1", "s2"]);
    expect(await s.getRun("s1")).toMatchObject({ threadId: "s1" });
  });
});
