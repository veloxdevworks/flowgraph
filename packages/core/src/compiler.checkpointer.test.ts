import { describe, it, expect, beforeAll } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { compileGraph, compileGraphForEmbedding } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

beforeAll(() => {
  registerFunction("echoCkpt", (input) => {
    const { text = "" } = input as { text?: string };
    return text;
  });
});

function sqliteSpec(enabled = true): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "checkpointer-sqlite" },
    state: {
      channels: {
        text: { type: "string" },
        out: { type: "string" },
      },
    },
    nodes: [
      {
        id: "echo",
        type: "function",
        with: { fn: "echoCkpt", input: { text: "{{ state.text }}" }, output: { to: "out" } },
      },
    ],
    edges: [
      { from: "START", to: "echo" },
      { from: "echo", to: "END" },
    ],
    runtime: { checkpoint: { enabled, backend: "sqlite", path: ".flowgraph/test.db" } },
  } as unknown as GraphSpec;
}

describe("resolveCheckpointer fail-fast", () => {
  it("throws when YAML requests sqlite and no saver instance is injected", async () => {
    await expect(compileGraph(sqliteSpec())).rejects.toThrow(/sqlite/i);
    await expect(compileGraph(sqliteSpec())).rejects.toThrow(/injected checkpointer/i);
  });

  it("uses in-memory when YAML requests sqlite and checkpointer is \"memory\"", async () => {
    const compiled = await compileGraph(sqliteSpec(), { checkpointer: "memory" });
    const result = await compiled.run({
      input: { text: "mem" },
      threadId: "ckpt-memory-string",
      onInterrupt: "fail",
    });
    expect(result.status).toBe("completed");
    expect((await compiled.getState("ckpt-memory-string"))?.values["out"]).toBe("mem");
  });

  it("does not throw when YAML requests sqlite and checkpointer is \"none\"", async () => {
    const compiled = await compileGraph(sqliteSpec(), { checkpointer: "none" });
    expect(compiled.spec.metadata.name).toBe("checkpointer-sqlite");
    const snap = await compiled.getState("unused");
    expect(snap).toBeNull();
  });

  it("uses an injected saver when YAML requests sqlite", async () => {
    const saver = new MemorySaver();
    const compiled = await compileGraph(sqliteSpec(), { checkpointer: saver });
    const result = await compiled.run({
      input: { text: "hello" },
      threadId: "ckpt-injected",
      onInterrupt: "fail",
    });
    expect(result.status).toBe("completed");
    expect(result.state["out"]).toBe("hello");

    const snap = await compiled.getState("ckpt-injected");
    expect(snap).not.toBeNull();
    expect(snap?.values["out"]).toBe("hello");
  });

  it("does not throw for subgraph embedding when child YAML requests sqlite", async () => {
    const embedded = await compileGraphForEmbedding(sqliteSpec());
    expect(embedded.compiledLg).toBeDefined();
  });

  it("skips durable-backend inspection when checkpoint.enabled is false", async () => {
    const compiled = await compileGraph(sqliteSpec(false));
    expect(await compiled.getState("unused")).toBeNull();
  });

  it("throws when YAML requests postgres and no saver instance is injected", async () => {
    const spec = sqliteSpec();
    spec.runtime = { checkpoint: { enabled: true, backend: "postgres" } };
    await expect(compileGraph(spec)).rejects.toThrow(/postgres/i);
  });
});
