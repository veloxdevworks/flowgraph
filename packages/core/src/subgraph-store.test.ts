import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "yaml";
import { InMemoryStore } from "@langchain/langgraph";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@flowgraph/spec";
import type { NodeRunContext } from "./context.js";

let dir = "";

beforeAll(async () => {
  registerFunction("sgStoreParentWrite", async (_input, ctx: NodeRunContext) => {
    await ctx.store!.put(["mem"], "fromParent", { v: "parent" });
    return { ok: true };
  });
  registerFunction("sgStoreChild", async (_input, ctx: NodeRunContext) => {
    if (!ctx.store) return { childHasStore: false, seen: null };
    const seen = (await ctx.store.get(["mem"], "fromParent"))?.value ?? null;
    await ctx.store.put(["mem"], "fromChild", { v: "child" });
    return { childHasStore: true, seen };
  });
  registerFunction("sgStoreParentRead", async (_input, ctx: NodeRunContext) => {
    return (await ctx.store!.get(["mem"], "fromChild"))?.value ?? null;
  });

  dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-subgraph-store-"));
  await fs.writeFile(path.join(dir, "child.graph.yaml"), yaml.stringify(childSpec()));
  await fs.writeFile(
    path.join(dir, "child-nostore.graph.yaml"),
    yaml.stringify(childSpec({ enabled: false })),
  );
  await fs.writeFile(
    path.join(dir, "child-sqlite.graph.yaml"),
    yaml.stringify(childSpec({ enabled: true, backend: "sqlite" })),
  );
});

afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

function childSpec(store?: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "store-child" },
    state: { channels: { childOut: { type: "object" } } },
    nodes: [{ id: "c", type: "function", with: { fn: "sgStoreChild", output: { to: "childOut" } } }],
    edges: [
      { from: "START", to: "c" },
      { from: "c", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false }, ...(store ? { store } : {}) },
  } as unknown as GraphSpec;
}

function parentSpec(childFile: string): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "store-parent" },
    state: { channels: { child: { type: "object" }, back: { type: "object" } } },
    nodes: [
      { id: "w", type: "function", with: { fn: "sgStoreParentWrite", output: "none" } },
      {
        id: "sub",
        type: "subgraph",
        uses: `./${childFile}`,
        with: { stateMap: { out: { child: "childOut" } } },
      },
      { id: "r", type: "function", with: { fn: "sgStoreParentRead", output: { to: "back" } } },
    ],
    edges: [
      { from: "START", to: "w" },
      { from: "w", to: "sub" },
      { from: "sub", to: "r" },
      { from: "r", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("subgraph store sharing", () => {
  it("child reads what the parent wrote, and the parent reads what the child wrote (default store)", async () => {
    const compiled = await compileGraph(parentSpec("child.graph.yaml"), { cwd: dir, checkpointer: "memory" });
    const r = await compiled.run({ threadId: "sg-store-1" });
    expect(r.status).toBe("completed");
    expect(r.state["child"]).toEqual({ childHasStore: true, seen: { v: "parent" } });
    expect(r.state["back"]).toEqual({ v: "child" });
  });

  it("child writes land in an injected host store", async () => {
    const store = new InMemoryStore();
    const compiled = await compileGraph(parentSpec("child.graph.yaml"), {
      cwd: dir,
      checkpointer: "memory",
      store,
    });
    const r = await compiled.run({ threadId: "sg-store-2" });
    expect(r.status).toBe("completed");
    expect((await store.get(["mem"], "fromChild"))?.value).toEqual({ v: "child" });
  });

  it("a child that declares a sqlite store shares the parent's store instead of failing", async () => {
    const compiled = await compileGraph(parentSpec("child-sqlite.graph.yaml"), { cwd: dir, checkpointer: "memory" });
    const r = await compiled.run({ threadId: "sg-store-3" });
    expect(r.status).toBe("completed");
    expect(r.state["child"]).toEqual({ childHasStore: true, seen: { v: "parent" } });
  });

  it("a child with runtime.store.enabled: false gets no store", async () => {
    const compiled = await compileGraph(parentSpec("child-nostore.graph.yaml"), { cwd: dir, checkpointer: "memory" });
    const r = await compiled.run({ threadId: "sg-store-4" });
    expect(r.status).toBe("completed");
    expect(r.state["child"]).toEqual({ childHasStore: false, seen: null });
    expect(r.state["back"]).toBeNull();
  });
});
