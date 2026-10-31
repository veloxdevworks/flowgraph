import { randomUUID } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { beforeAll, describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import type { NodeRunContext } from "../context.js";
import { compileGraph } from "../compiler.js";
import { createLangChainProvider } from "../index.js";
import { registerFunction } from "../nodes/function.js";
import "../nodes/index.js";
import { createInMemoryMemoryBackend } from "./in-memory.js";
import { MemoryRuntime } from "./runtime.js";
import { tupleForScope } from "./scope.js";

const seen: Array<{ value: unknown; deduped: boolean }> = [];

beforeAll(() => {
  registerFunction("memToolBump", async (_i, ctx: NodeRunContext) => {
    const r = await ctx.memory!.increment("graph", "n", "");
    seen.push({ value: r.value, deduped: r.deduped });
    if (seen.length === 2) ctx.interrupt({ reason: "hold" });
    return r.value;
  });
});

/** One model: first turn calls `bump` twice; later turns finish. */
function scripted() {
  let n = 0;
  return createLangChainProvider(
    {
      invoke: async () => {
        const turn = n++;
        if (turn === 0) {
          return new AIMessage({
            content: "",
            tool_calls: [
              { name: "bump", id: "c0", args: {} },
              { name: "bump", id: "c1", args: {} },
            ],
          });
        }
        return new AIMessage({ content: "done" });
      },
      bindTools() {
        return this;
      },
    } as never,
    { name: "mem-tool" },
  );
}

describe("memory writes inside agent tool calls", () => {
  it("a resumed call matches its own write, not an earlier cached call", async () => {
    seen.length = 0;
    const backend = createInMemoryMemoryBackend();
    const identity = { org: "acme", project: "web", user: "dev@acme.test" };
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "mem-tool" },
      state: { channels: { out: { type: "object" } } },
      nodes: [
        { id: "gate", type: "function", when: "false", with: { fn: "memToolBump" } },
        {
          id: "o",
          type: "agent",
          provider: "mem-tool",
          with: { prompt: "go", tools: [{ node: "bump" }], output: { to: "out" } },
        },
        { id: "bump", type: "function", when: "false", with: { fn: "memToolBump" } },
      ],
      edges: [
        { from: "START", to: "o" },
        { from: "o", to: "END" },
        { from: "START", to: "gate" },
        { from: "gate", to: "bump" },
        { from: "bump", to: "END" },
      ],
      runtime: { checkpoint: { backend: "memory" }, memory: {} },
    } as unknown as GraphSpec;
    const saver = new MemorySaver();
    const providers = [scripted()];
    const compile = () =>
      compileGraph(spec, { checkpointer: saver, providers: providers as never, memory: { backend, identity } });
    const threadId = `mem-tool-${randomUUID()}`;
    const first = await (await compile()).run({ threadId, onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");
    expect(seen.map((s) => s.value)).toEqual([1, 2]);
    seen.length = 0;
    const resumed = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
    expect(resumed.status).toBe("completed");
    // The second call runs again; the first stays cached. Its replay returns the
    // value that call stored, and does not apply another increment.
    expect(seen).toEqual([{ value: 2, deduped: true }]);
    const tuple = tupleForScope({ ...identity, graph: "mem-tool" }, "graph");
    expect((await backend.get(tuple, "n"))?.value).toBe(2);
  });

  it("a tool-call path is its own replay identity; a top-level node keeps its id", () => {
    expect(MemoryRuntime.nodeIdForScope([], "n")).toBe("n");
    expect(MemoryRuntime.nodeIdForScope(["o", "tool:1"], "bump")).toBe(JSON.stringify(["o", "tool:1"]));
    expect(MemoryRuntime.nodeIdForScope(["sub"], "n")).toBe(JSON.stringify(["sub", "n"]));
  });
});
