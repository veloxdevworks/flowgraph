import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { beforeAll, describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import type { NodeRunContext } from "../context.js";
import { compileGraph } from "../compiler.js";
import { createLangChainProvider, createScriptedProvider } from "../index.js";
import { registerFunction } from "../nodes/function.js";
import "../nodes/index.js";
import { createInMemoryMemoryBackend } from "./in-memory.js";
import { tupleForScope } from "./scope.js";

const seen: Array<{ value: unknown; deduped: boolean }> = [];
let summaries = 0;

beforeAll(() => {
  registerFunction("mergeCtxBump", async (_i, ctx: NodeRunContext) => {
    const r = await ctx.memory!.increment("graph", "n", "");
    seen.push({ value: r.value, deduped: r.deduped });
    ctx.interrupt({ reason: "hold" });
    return { n: r.value, blob: "x".repeat(8_000) };
  });
});

const identity = { org: "acme", project: "web", user: "dev@acme.test" };

function model() {
  let n = 0;
  return createLangChainProvider(
    {
      invoke: async () => {
        const turn = n++;
        if (turn === 0) {
          return new AIMessage({ content: "", tool_calls: [{ name: "bump", id: "c0", args: {} }] });
        }
        return new AIMessage({ content: "done" });
      },
      bindTools() {
        return this;
      },
    } as never,
    { name: "merge-ctx-llm" },
  );
}

describe("memory op ids with subgraph merge-back and context budgets", () => {
  it("a subgraph child write still applies once after the parent merges the child state", async () => {
    seen.length = 0;
    const child = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "mem-merge-child" },
      state: { channels: { note: { type: "string" } } },
      nodes: [{ id: "bump", type: "function", with: { fn: "mergeCtxBump" } }],
      edges: [
        { from: "START", to: "bump" },
        { from: "bump", to: "END" },
      ],
    };
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "mem-merge-sub" },
      state: { channels: { note: { type: "string" } } },
      nodes: [{ id: "sg", type: "subgraph", spec: child }],
      edges: [
        { from: "START", to: "sg" },
        { from: "sg", to: "END" },
      ],
      runtime: { memory: {} },
    } as unknown as GraphSpec;
    const backend = createInMemoryMemoryBackend();
    const saver = new MemorySaver();
    const compile = () => compileGraph(spec, { checkpointer: saver, memory: { backend, identity } });
    const threadId = `mem-merge-${randomUUID()}`;
    const first = await (await compile()).run({ threadId, input: { note: "seed" }, onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");
    expect(seen).toEqual([{ value: 1, deduped: false }]);
    seen.length = 0;
    const second = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
    expect(second.status).toBe("completed");
    expect(seen).toEqual([{ value: 1, deduped: true }]);
    const tuple = tupleForScope({ ...identity, graph: "mem-merge-sub" }, "graph");
    expect((await backend.get(tuple, "n"))?.value).toBe(1);
  });

  it("a context agent's tool write still applies once when the resume reuses a cached summary", async () => {
    seen.length = 0;
    const chat = [];
    for (let i = 0; i < 8; i++) {
      chat.push(new HumanMessage({ id: `u${i}`, content: `q${i} ${"q".repeat(500)}` }));
      chat.push(new AIMessage({ id: `a${i}`, content: `a${i} ${"a".repeat(500)}` }));
    }
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "mem-ctx-agent" },
      state: { channels: { chat: { type: "messages" }, out: { type: "object" } } },
      nodes: [
        {
          id: "o",
          type: "agent",
          provider: "merge-ctx-llm",
          with: {
            prompt: "go",
            tools: [{ node: "bump" }],
            context: {
              history: "chat",
              maxTokens: 800,
              strategy: "summarize",
              toolResultMaxTokens: 100,
              summarize: { provider: "merge-ctx-sum", maxTokens: 80 },
            },
            output: { to: "out" },
          },
        },
        { id: "bump", type: "function", when: "false", with: { fn: "mergeCtxBump" } },
        { id: "gate", type: "function", when: "false", with: { fn: "mergeCtxBump" } },
      ],
      edges: [
        { from: "START", to: "o" },
        { from: "o", to: "END" },
        { from: "START", to: "gate" },
        { from: "gate", to: "bump" },
        { from: "bump", to: "END" },
      ],
      runtime: { memory: {} },
    } as unknown as GraphSpec;
    summaries = 0;
    const summarizer = createScriptedProvider("merge-ctx-sum", () => {
      summaries++;
      return { output: "folded earlier turns", stopReason: "done" };
    });
    const backend = createInMemoryMemoryBackend();
    const saver = new MemorySaver();
    const providers = [model(), summarizer];
    const compile = () =>
      compileGraph(spec, { checkpointer: saver, providers: providers as never, memory: { backend, identity } });
    const threadId = `mem-ctx-${randomUUID()}`;
    const first = await (await compile()).run({ threadId, input: { chat }, onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");
    expect(seen).toEqual([{ value: 1, deduped: false }]);
    // The over-budget history was folded once, into the replay store, before the tool ran.
    expect(summaries).toBe(1);
    seen.length = 0;
    const second = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
    expect(second.status, String(second.error ?? "")).toBe("completed");
    expect(seen).toEqual([{ value: 1, deduped: true }]);
    // The summary made before the tool is reused; the resume does not fold the same history again.
    expect(summaries).toBe(1);
    const chatAfter = (second.state as { chat?: Array<{ id?: string }> }).chat ?? [];
    expect(chatAfter.filter((m) => String(m.id ?? "").includes("summary"))).toHaveLength(1);
    const tuple = tupleForScope({ ...identity, graph: "mem-ctx-agent" }, "graph");
    expect((await backend.get(tuple, "n"))?.value).toBe(1);
  });
});
