import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "yaml";
import { compileGraph } from "../compiler.js";
import { registerFunction } from "../nodes/function.js";
import { validateSpec } from "../loader.js";
import type { GraphSpec } from "@flowgraph/spec";
import type { NodeRunContext } from "../context.js";
import {
  createInMemoryMemoryBackend,
  createScopedMemory,
  defaultMemoryPolicy,
  isMemoryError,
  memoryHostDiagnostics,
  normalizeSubjectKey,
  tupleForScope,
  MEMORY_DEFAULT_LIMITS,
  type MemoryBackend,
  type MemoryIdentity,
} from "./index.js";

const identity: MemoryIdentity = { org: "acme", project: "github.com/acme/web", user: "dev@acme.test" };
let dir = "";

beforeAll(async () => {
  registerFunction("mtExpose", async (_i, ctx: NodeRunContext) => ({
    hasMemory: !!ctx.memory,
    hasStore: !!ctx.store,
    durable: ctx.memory?.durable ?? null,
    scope: ctx.meta.memoryScope ?? null,
  }));
  registerFunction("mtBump", async (_i, ctx: NodeRunContext) => (await ctx.memory!.increment("graph", "n", "")).value);
  registerFunction("mtCas", async (_i, ctx: NodeRunContext) => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx.memory!.update("project", "cas", (cur) => ((cur as number | undefined) ?? 0) + 1, { retries: 50 }),
      ),
    );
    return (await ctx.memory!.get("cas"))?.value;
  });
  registerFunction("mtSubjectNoDecl", async (_i, ctx: NodeRunContext) => {
    try {
      await ctx.memory!.put("subject", "x", 1);
      return "wrote";
    } catch (e) {
      return isMemoryError(e) ? e.code : String(e);
    }
  });
  registerFunction("mtSecret", async (_i, ctx: NodeRunContext) => {
    try {
      await ctx.memory!.put("graph", "tok", { t: "ghp_" + "a".repeat(36) });
      return "wrote";
    } catch (e) {
      return isMemoryError(e) ? e.code : String(e);
    }
  });
  registerFunction("mtPrecedence", async (_i, ctx: NodeRunContext) => {
    await ctx.memory!.put("project", "style", "project");
    await ctx.memory!.put("graph", "style", "graph");
    const first = (await ctx.memory!.get("style"))?.scope;
    await ctx.memory!.put("user", "style", "user");
    const second = (await ctx.memory!.get("style"))?.scope;
    const pinned = (await ctx.memory!.get("style", { scopes: ["project"] }))?.value;
    return { first, second, pinned };
  });
  registerFunction("mtChildWrite", async (_i, ctx: NodeRunContext) => {
    await ctx.memory!.increment("graph", "child", "n");
    return ctx.memory!.scope;
  });
  registerFunction("mtLegacyBurst", async (_i, ctx: NodeRunContext) => {
    await ctx.store!.put(["a", "b"], "k1", { n: 1, tag: "x" });
    await ctx.store!.put(["a", "b"], "k2", { n: 5, tag: "y" });
    await ctx.store!.put(["a", "c"], "k3", { n: 9, tag: "x" });
    const tagged = (await ctx.store!.search(["a"], { filter: { tag: "x" } })).map((i) => i.key).sort();
    const big = (await ctx.store!.search(["a"], { filter: { n: { $gt: 2 } } })).map((i) => i.key).sort();
    const ns = await ctx.store!.listNamespaces({ prefix: ["a"] });
    await ctx.store!.delete(["a", "b"], "k1");
    const after = await ctx.store!.get(["a", "b"], "k1");
    return { tagged, big, ns: ns.map((n) => n.join("/")).sort(), after };
  });

  dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-memory-"));
  await fs.writeFile(
    path.join(dir, "child.graph.yaml"),
    yaml.stringify(fnGraph("mem-child", "mtChildWrite", { checkpoint: { enabled: false } })),
  );
});

afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

function fnGraph(name: string, fn: string, runtime: Record<string, unknown> = { memory: {} }): GraphSpec {
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
    runtime: { checkpoint: { backend: "sqlite" }, ...runtime },
  } as unknown as GraphSpec;
}

async function run(spec: GraphSpec, backend: MemoryBackend, threadId = `t-${Math.random()}`, input?: Record<string, unknown>) {
  const c = await compileGraph(spec, { checkpointer: "memory", memory: { backend, identity } });
  return c.run({ threadId, onInterrupt: "fail", ...(input ? { input } : {}) });
}

describe("ctx.memory exposure", () => {
  it("runtime.memory exposes ctx.memory and the run's scope", async () => {
    const r = await run(fnGraph("g", "mtExpose"), createInMemoryMemoryBackend());
    expect(r.state["out"]).toEqual({
      hasMemory: true,
      hasStore: true,
      durable: false,
      scope: { org: "acme", project: "github.com/acme/web", graph: "g", user: "dev@acme.test" },
    });
  });

  it("a graph without runtime.memory gets the legacy store but no ctx.memory", async () => {
    const c = await compileGraph(fnGraph("g", "mtExpose", {}), { checkpointer: "memory" });
    const r = await c.run({ threadId: "plain" });
    expect(r.state["out"]).toMatchObject({ hasMemory: false, hasStore: true, scope: null });
  });

  it("runtime.memory without a host backend fails loudly instead of going in-memory", async () => {
    await expect(compileGraph(fnGraph("g", "mtExpose"), { checkpointer: "memory" })).rejects.toThrow(
      /MEMORY_BACKEND_UNAVAILABLE: runtime\.memory needs a memory backend for its sqlite checkpointer, and this host provided none\. Run it with the flowgraph CLI.*Silent in-memory fallback is not allowed/s,
    );
  });

  it('memory: "ephemeral" and runtime.memory.backend: memory run without a host', async () => {
    const a = await compileGraph(fnGraph("g", "mtExpose"), { checkpointer: "memory", memory: "ephemeral" });
    expect((await a.run({ threadId: "e1" })).state["out"]).toMatchObject({ hasMemory: true, durable: false });
    const b = await compileGraph(fnGraph("g", "mtExpose", { memory: { backend: "memory" } }), { checkpointer: "memory" });
    expect((await b.run({ threadId: "e2" })).state["out"]).toMatchObject({ hasMemory: true });
  });

  it("runtime.store plus runtime.memory is rejected", async () => {
    await expect(
      compileGraph(fnGraph("g", "mtExpose", { memory: {}, store: { backend: "sqlite" } }), { checkpointer: "memory", memory: "ephemeral" }),
    ).rejects.toThrow(/MEMORY_STORE_AND_MEMORY/);
  });
});

describe("ctx.memory semantics through a graph", () => {
  it("counts across runs and isolates graphs on one backend", async () => {
    const be = createInMemoryMemoryBackend();
    await run(fnGraph("a", "mtBump"), be);
    expect((await run(fnGraph("a", "mtBump"), be)).state["out"]).toBe(2);
    expect((await run(fnGraph("b", "mtBump"), be)).state["out"]).toBe(1);
  });

  it("concurrent CAS updates inside one node lose nothing", async () => {
    const r = await run(fnGraph("cas", "mtCas"), createInMemoryMemoryBackend());
    expect(r.state["out"]).toBe(20);
  });

  it("subject scope without a declared subject is unavailable", async () => {
    const r = await run(fnGraph("s", "mtSubjectNoDecl"), createInMemoryMemoryBackend());
    expect(r.state["out"]).toBe("MEMORY_SCOPE_UNAVAILABLE");
  });

  it("secrets are refused", async () => {
    const r = await run(fnGraph("s", "mtSecret"), createInMemoryMemoryBackend());
    expect(r.state["out"]).toBe("MEMORY_SECRET_DETECTED");
  });

  it("reads follow user > subject > graph > project > org", async () => {
    const r = await run(fnGraph("p", "mtPrecedence"), createInMemoryMemoryBackend());
    expect(r.state["out"]).toEqual({ first: "graph", second: "user", pinned: "project" });
  });

  it("subject keys can be hashed so raw identifiers are not stored", async () => {
    const be = createInMemoryMemoryBackend();
    const spec = fnGraph("h", "mtExpose", {
      memory: { subject: { type: "customer", key: "{{ input.email }}", hash: true } },
    });
    const r = await run(spec, be, "h1", { email: "Pat@Example.com" });
    const subject = (r.state["out"] as { scope: { subject: { key: string } } }).scope.subject;
    expect(subject.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(subject.key).toBe(normalizeSubjectKey("Pat@Example.com", { hash: true }));
  });

  it("an optional subject that renders empty leaves the subject unbound", async () => {
    const spec = fnGraph("o", "mtExpose", { memory: { subject: { type: "ticket", key: "{{ input.ticket }}" } } });
    const r = await run(spec, createInMemoryMemoryBackend(), "o1", {});
    expect((r.state["out"] as { scope: Record<string, unknown> }).scope["subject"]).toBeUndefined();
  });

  it("an embedded subgraph writes under the root graph's scope and backend", async () => {
    const be = createInMemoryMemoryBackend();
    const parent = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "mem-parent" },
      state: { channels: { child: { type: "object" } } },
      nodes: [{ id: "sub", type: "subgraph", uses: "./child.graph.yaml", with: { stateMap: { out: { child: "out" } } } }],
      edges: [
        { from: "START", to: "sub" },
        { from: "sub", to: "END" },
      ],
      runtime: { checkpoint: { backend: "sqlite" }, memory: {} },
    } as unknown as GraphSpec;
    const c = await compileGraph(parent, { cwd: dir, checkpointer: "memory", memory: { backend: be, identity } });
    const r = await c.run({ threadId: "sg" });
    expect(r.status).toBe("completed");
    expect(r.state["child"]).toMatchObject({ graph: "mem-parent" });
    const t = tupleForScope({ ...identity, graph: "mem-parent", user: identity.user! }, "graph");
    expect((await be.get(t, "child"))?.value).toEqual({ n: 1 });
  });
});

describe("legacy ctx.store adapter", () => {
  it("supports namespaces, filters, listNamespaces and delete", async () => {
    const r = await run(fnGraph("legacy", "mtLegacyBurst", {}), createInMemoryMemoryBackend());
    expect(r.state["out"]).toEqual({ tagged: ["k1", "k3"], big: ["k2", "k3"], ns: ["a/b", "a/c"], after: null });
  });
});

describe("ScopedMemory handle", () => {
  const binding = { org: "o", project: "p", graph: "g", user: "" };

  it("user scope is unavailable when the run has no user", async () => {
    const m = createScopedMemory(createInMemoryMemoryBackend(), binding, defaultMemoryPolicy(), {});
    await expect(m.put("user", "k", 1)).rejects.toThrow(/MEMORY_SCOPE_UNAVAILABLE/);
    await expect(m.get("k", { scopes: ["user"] })).resolves.toBeNull();
  });

  it("replays with the same op source are applied once", async () => {
    const be = createInMemoryMemoryBackend();
    const src = { threadId: "t", checkpointNs: "n:1", taskId: "task-1", nodeId: "n" };
    for (let attempt = 0; attempt < 3; attempt++) {
      const m = createScopedMemory(be, binding, defaultMemoryPolicy(), src);
      const r = await m.increment("graph", "k", "n");
      expect(r.version).toBe(1);
      expect(r.deduped).toBe(attempt > 0);
    }
    // A different task is a different op.
    const m2 = createScopedMemory(be, binding, defaultMemoryPolicy(), { ...src, taskId: "task-2" });
    expect((await m2.increment("graph", "k", "n")).value).toEqual({ n: 2 });
  });

  it("search caps the limit and filters by prefix/attrs", async () => {
    const m = createScopedMemory(createInMemoryMemoryBackend(), binding, defaultMemoryPolicy(), {});
    for (let i = 0; i < 5; i++) await m.put("graph", `fix/${i}`, i, { attrs: { ok: i % 2 === 0 } });
    await m.put("project", "fix/p", "p", { attrs: { ok: true } });
    expect((await m.search({ prefix: "fix/", attrs: { ok: true } })).map((r) => r.key).sort()).toEqual(["fix/0", "fix/2", "fix/4", "fix/p"]);
    expect(await m.search({ prefix: "fix/", limit: 2, scopes: ["graph"] })).toHaveLength(2);
    expect(MEMORY_DEFAULT_LIMITS.itemsPerScope).toBe(500);
  });
});

describe("memory validation", () => {
  const codes = (spec: GraphSpec) => validateSpec(spec).map((d) => `${d.severity}:${d.code}`);

  it("flags runtime.memory without a durable checkpointer", () => {
    expect(codes(fnGraph("v", "mtExpose", { checkpoint: { backend: "memory" }, memory: {} }))).toContain(
      "error:MEMORY_BACKEND_UNAVAILABLE",
    );
  });

  it("flags a store backend that does not match the checkpointer", () => {
    expect(codes(fnGraph("v", "mtExpose", { checkpoint: { backend: "sqlite" }, store: { backend: "postgres" } }))).toContain(
      "error:MEMORY_BACKEND_UNAVAILABLE",
    );
    expect(codes(fnGraph("v", "mtExpose", { checkpoint: { backend: "sqlite" }, store: { backend: "sqlite" } }))).not.toContain(
      "error:MEMORY_BACKEND_UNAVAILABLE",
    );
  });

  it("flags store + memory, ephemeral memory, and limits over the hard cap", () => {
    expect(codes(fnGraph("v", "mtExpose", { memory: {}, store: { backend: "sqlite" } }))).toContain("error:MEMORY_STORE_AND_MEMORY");
    expect(codes(fnGraph("v", "mtExpose", { memory: { backend: "memory" } }))).toContain("warning:MEMORY_BACKEND_EPHEMERAL");
    expect(codes(fnGraph("v", "mtExpose", { memory: { limits: { itemBytes: 1_000_000 } } }))).toContain("error:MEMORY_LIMIT_EXCEEDS_CAP");
  });

  it("checks memory nodes", () => {
    const spec = (runtime: Record<string, unknown>, w: Record<string, unknown>) =>
      ({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "v" },
        state: { channels: {} },
        nodes: [{ id: "m", type: "memory", with: w }],
        edges: [
          { from: "START", to: "m" },
          { from: "m", to: "END" },
        ],
        runtime: { checkpoint: { backend: "sqlite" }, ...runtime },
      }) as unknown as GraphSpec;
    expect(codes(spec({}, { op: "get", key: "k" }))).toContain("error:MEMORY_NOT_CONFIGURED");
    expect(codes(spec({ memory: {} }, { op: "put", scope: "subject", key: "k", value: 1 }))).toContain("error:MEMORY_SUBJECT_UNDECLARED");
    expect(codes(spec({ memory: {} }, { op: "put", key: "k", value: 1 }))).toContain("warning:MEMORY_SCOPE_IMPLICIT");
    expect(codes(spec({ memory: {} }, { op: "put", scope: "graph", key: "k", value: 1 })).filter((c) => c.includes("MEMORY"))).toEqual([]);
  });

  it("host diagnostics reject backends the host cannot store memory in", () => {
    const pg = fnGraph("v", "mtExpose", { checkpoint: { backend: "postgres" }, memory: {} });
    expect(memoryHostDiagnostics(pg, { memoryBackends: ["sqlite"], hostName: "flowgraph CLI" })[0]?.message).toMatch(
      /flowgraph CLI cannot store runtime\.memory in a postgres checkpointer/,
    );
    expect(memoryHostDiagnostics(fnGraph("v", "mtExpose"), { memoryBackends: ["sqlite"], hostName: "x" })).toEqual([]);
  });
});

describe("startMemorySweeper", () => {
  it("sweeps on demand with the op retention it was given, and never overlaps", async () => {
    const { createInMemoryMemoryBackend, startMemorySweeper, MEMORY_DEFAULT_LIMITS: limits } = await import("../index.js");
    const b = createInMemoryMemoryBackend();
    const t = { org: "acme", project: "p", graph: "g", usr: "", subjectType: "", subjectKey: "" };
    await b.write({ kind: "put", tuple: t, key: "gone", value: 1, ttlMs: 1, limits, now: 0 });
    await b.write({ kind: "put", tuple: t, key: "op", value: 1, opId: "o-1", limits, now: 0 });
    const counts: number[] = [];
    const s = startMemorySweeper(b, { intervalMs: 60_000, opsRetentionMs: 0, onSweep: (n) => counts.push(n) });
    const [a, c] = [s.sweepNow(), s.sweepNow()];
    expect(a).toBe(c);
    expect(await a).toBe(1);
    s.stop();
    expect(counts).toEqual([1]);
    // The op record was swept (retention 0), so the same op id applies again.
    expect((await b.write({ kind: "put", tuple: t, key: "op", value: 1, opId: "o-1", limits })).deduped).toBe(false);
  });

  it("refuses intervals a Node timer cannot honor, so a sweep never busy-loops", async () => {
    const { createInMemoryMemoryBackend, startMemorySweeper, MEMORY_SWEEP_MAX_INTERVAL_MS } = await import("../index.js");
    expect(MEMORY_SWEEP_MAX_INTERVAL_MS).toBe(2 ** 31 - 1);
    const b = createInMemoryMemoryBackend();
    for (const intervalMs of [2 ** 31, 1e12, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => startMemorySweeper(b, { intervalMs }), String(intervalMs)).toThrow(/intervalMs must be a finite number of milliseconds up to 2147483647/);
    }
    // The maximum is accepted and does not fire early.
    let calls = 0;
    const s = startMemorySweeper(b, { intervalMs: MEMORY_SWEEP_MAX_INTERVAL_MS, sweep: async () => (calls++, 0) });
    await new Promise((r) => setTimeout(r, 50));
    s.stop();
    expect(calls).toBe(0);
  });

  it("a custom sweep replaces backend.sweep", async () => {
    const { createInMemoryMemoryBackend, startMemorySweeper } = await import("../index.js");
    const b = createInMemoryMemoryBackend();
    const calls: number[] = [];
    b.sweep = async () => {
      throw new Error("backend.sweep should not run");
    };
    const s = startMemorySweeper(b, { intervalMs: 60_000, sweep: async (now) => (calls.push(now), 7) });
    expect(await s.sweepNow()).toBe(7);
    s.stop();
    expect(calls).toHaveLength(1);
  });
});
