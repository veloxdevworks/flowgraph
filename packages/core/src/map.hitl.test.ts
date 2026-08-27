import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@flowgraph/spec";

beforeAll(() => {
  registerFunction("echo-item", (input) => {
    const n = (input as { n?: number }).n ?? 0;
    return { n, doubled: n * 2 };
  });
});

function mapHitlSpec(): GraphSpec {
  return {
    metadata: { name: "map-hitl" },
    state: { channels: { numbers: { type: "array" }, doubled: { type: "array" } } },
    nodes: [
      {
        id: "map-items",
        type: "map",
        with: {
          over: "{{ state.numbers }}",
          as: "n",
          concurrency: 2,
          node: {
            type: "hitl",
            with: {
              mode: "approve",
              message: "Approve item {{ item.n }}",
              output: { to: "itemResult" },
            },
          },
          collect: { to: "doubled" },
        },
      },
    ],
    edges: [
      { from: "START", to: "map-items" },
      { from: "map-items", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("checkpointed map + HITL", () => {
  it("still collects ordered results when the inner node has no interrupt", async () => {
    const spec = {
      metadata: { name: "map-graph" },
      state: { channels: { numbers: { type: "array" }, doubled: { type: "array" } } },
      nodes: [
        {
          id: "map-double",
          type: "map",
          with: {
            over: "{{ state.numbers }}",
            as: "n",
            concurrency: 2,
            node: {
              type: "function",
              with: { fn: "echo-item", input: { n: "{{ item.n }}" } },
            },
            collect: { to: "doubled" },
          },
        },
      ],
      edges: [
        { from: "START", to: "map-double" },
        { from: "map-double", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { numbers: [1, 2, 3, 4] } });
    expect(r.status).toBe("completed");
    expect(r.state["doubled"]).toEqual([
      { n: 1, doubled: 2 },
      { n: 2, doubled: 4 },
      { n: 3, doubled: 6 },
      { n: 4, doubled: 8 },
    ]);
  });

  it("pauses per item and resumes only the interrupted Send", async () => {
    const compiled = await compileGraph(mapHitlSpec(), {});
    const threadId = `map-hitl-${Date.now()}`;
    const first = await compiled.run({
      input: { numbers: [1, 2] },
      threadId,
      onInterrupt: "fail",
    });
    expect(first.status).toBe("interrupted");
    expect((first.interrupts ?? []).length).toBeGreaterThan(0);

    const resumed = await compiled.resume({
      threadId,
      resume: { approved: true },
      onInterrupt: "fail",
    });
    // First resume may still have the sibling item pending.
    if (resumed.status === "interrupted") {
      const second = await compiled.resume({
        threadId,
        resume: { approved: true },
        onInterrupt: "fail",
      });
      expect(second.status).toBe("completed");
      expect(Array.isArray(second.state["doubled"])).toBe(true);
      expect((second.state["doubled"] as unknown[]).length).toBe(2);
    } else {
      expect(resumed.status).toBe("completed");
      expect((resumed.state["doubled"] as unknown[]).length).toBe(2);
    }
  });

  it("pauses nested subgraph HITL at concurrency 2 and resumes each item", async () => {
    const spec = {
      metadata: { name: "map-sub-hitl" },
      state: { channels: { numbers: { type: "array" }, doubled: { type: "array" } } },
      nodes: [
        {
          id: "map-items",
          type: "map",
          with: {
            over: "{{ state.numbers }}",
            as: "n",
            concurrency: 2,
            node: {
              type: "subgraph",
              spec: {
                metadata: { name: "item-child" },
                state: { channels: { gateResult: { type: "object" } } },
                nodes: [
                  {
                    id: "human-gate",
                    type: "hitl",
                    with: {
                      mode: "approve",
                      message: "Approve nested item",
                      output: { to: "gateResult" },
                    },
                  },
                ],
                edges: [
                  { from: "START", to: "human-gate" },
                  { from: "human-gate", to: "END" },
                ],
                runtime: { checkpoint: { enabled: true, backend: "memory" } },
              },
              with: { output: { to: "itemResult" } },
            },
            collect: { to: "doubled" },
          },
        },
      ],
      edges: [
        { from: "START", to: "map-items" },
        { from: "map-items", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const threadId = `map-sub-${Date.now()}`;
    let result = await compiled.run({
      input: { numbers: [1, 2] },
      threadId,
      onInterrupt: "fail",
    });
    expect(result.status).toBe("interrupted");

    let guards = 0;
    while (result.status === "interrupted" && guards++ < 6) {
      result = await compiled.resume({
        threadId,
        resume: { approved: true },
        onInterrupt: "fail",
      });
    }
    expect(result.status).toBe("completed");
    expect((result.state["doubled"] as unknown[]).length).toBe(2);
  });

  it("fails the map when a mid-pool item throws", async () => {
    registerFunction("maybe-fail", (input) => {
      const n = (input as { n?: number }).n ?? 0;
      if (n === 3) throw new Error("boom-3");
      return n * 2;
    });
    const spec = {
      metadata: { name: "map-err" },
      state: { channels: { numbers: { type: "array" }, doubled: { type: "array" } } },
      nodes: [
        {
          id: "map-double",
          type: "map",
          with: {
            over: "{{ state.numbers }}",
            as: "n",
            concurrency: 2,
            node: {
              type: "function",
              with: { fn: "maybe-fail", input: { n: "{{ item.n }}" } },
            },
            collect: { to: "doubled" },
          },
        },
      ],
      edges: [
        { from: "START", to: "map-double" },
        { from: "map-double", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { numbers: [1, 2, 3, 4] } });
    expect(r.status).toBe("error");
    expect(r.error?.message).toMatch(/boom-3/);
  });
});
