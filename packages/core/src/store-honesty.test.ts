import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryStore } from "@langchain/langgraph";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@flowgraph/spec";
import type { NodeRunContext } from "./context.js";

beforeAll(() => {
  registerFunction("storeHonestyProbe", async (_input, ctx: NodeRunContext) => {
    if (!ctx.store) return { hasStore: false };
    await ctx.store.put(["probe"], "k", { v: 1 });
    const item = await ctx.store.get(["probe"], "k");
    return { hasStore: true, value: item?.value ?? null };
  });
});

function spec(store?: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "store-honesty" },
    state: { channels: { result: { type: "object" } } },
    nodes: [{ id: "n", type: "function", with: { fn: "storeHonestyProbe", output: { to: "result" } } }],
    edges: [
      { from: "START", to: "n" },
      { from: "n", to: "END" },
    ],
    runtime: {
      checkpoint: { enabled: true, backend: "memory" },
      ...(store ? { store } : {}),
    },
  } as unknown as GraphSpec;
}

async function hasStore(s: GraphSpec, opts: Parameters<typeof compileGraph>[1] = {}): Promise<boolean> {
  const compiled = await compileGraph(s, { checkpointer: "memory", ...opts });
  const r = await compiled.run({ threadId: "t" });
  expect(r.status).toBe("completed");
  return (r.state["result"] as { hasStore: boolean }).hasStore;
}

describe("resolveStore honesty", () => {
  it("rejects removed runtime.store in GraphSpecSchema", async () => {
    const { GraphSpecSchema } = await import("@flowgraph/spec");
    expect(GraphSpecSchema.safeParse(spec({ enabled: true, backend: "sqlite" })).success).toBe(false);
    expect(GraphSpecSchema.safeParse(spec({ enabled: true, backend: "postgres" })).success).toBe(false);
  });

  it("uses an injected store instance", async () => {
    const store = new InMemoryStore();
    expect(await hasStore(spec(), { store })).toBe(true);
    expect((await store.get(["probe"], "k"))?.value).toEqual({ v: 1 });
  });

  it('honors an explicit store: "memory" override', async () => {
    expect(await hasStore(spec(), { store: "memory" })).toBe(true);
  });

  it("defaults to an in-memory store", async () => {
    expect(await hasStore(spec())).toBe(true);
  });

  it('gives no store for store: "none"', async () => {
    expect(await hasStore(spec(), { store: "none" })).toBe(false);
  });
});
