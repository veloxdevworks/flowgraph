import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStore } from "@langchain/langgraph";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { NodeRunContext } from "./context.js";

function storeGraph(fn: string): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "store-graph" },
    state: { channels: { result: { type: "object" } } },
    nodes: [
      {
        id: "store-op",
        type: "function",
        with: {
          fn,
          output: { to: "result" },
        },
      },
    ],
    edges: [
      { from: "START", to: "store-op" },
      { from: "store-op", to: "END" },
    ],
    runtime: {
      checkpoint: { enabled: true, backend: "memory" },
      store: { enabled: true, backend: "memory" },
    },
  } as unknown as GraphSpec;
}

describe("store", () => {
  beforeEach(() => {
    registerFunction("storeWrite", async (_input, ctx: NodeRunContext) => {
      if (!ctx.store) throw new Error("ctx.store is not available");
      await ctx.store.put(["users", "alice"], "prefs", { theme: "dark" });
      return { wrote: true };
    });

    registerFunction("storeRead", async (_input, ctx: NodeRunContext) => {
      if (!ctx.store) throw new Error("ctx.store is not available");
      const item = await ctx.store.get(["users", "alice"], "prefs");
      return { value: item?.value ?? null };
    });

    registerFunction("storeMissing", async (_input, ctx: NodeRunContext) => {
      return { hasStore: ctx.store != null };
    });
  });

  it("persists data across different thread ids on the same compiled graph", async () => {
    const store = new InMemoryStore();
    const writeCompiled = await compileGraph(storeGraph("storeWrite"), {
      checkpointer: "memory",
      store,
    });
    const readCompiled = await compileGraph(storeGraph("storeRead"), {
      checkpointer: "memory",
      store,
    });

    const w = await writeCompiled.run({ threadId: "thread-a" });
    expect(w.status).toBe("completed");
    expect((w.state["result"] as { wrote: boolean }).wrote).toBe(true);

    const r = await readCompiled.run({ threadId: "thread-b" });
    expect(r.status).toBe("completed");
    expect((r.state["result"] as { value: { theme: string } }).value).toEqual({ theme: "dark" });
  });

  it("leaves ctx.store undefined when store is disabled", async () => {
    const spec = {
      ...storeGraph("storeMissing"),
      runtime: {
        checkpoint: { enabled: true, backend: "memory" },
        store: { enabled: false },
      },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, { checkpointer: "memory", store: "none" });
    const result = await compiled.run({ threadId: "no-store" });
    expect(result.status).toBe("completed");
    expect((result.state["result"] as { hasStore: boolean }).hasStore).toBe(false);
  });
});
