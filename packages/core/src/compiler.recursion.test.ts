import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

beforeAll(() => {
  registerFunction("inc", (input) => {
    const n = Number((input as { n?: number }).n ?? 0);
    return n + 1;
  });
});

describe("runtime.recursionLimit", () => {
  it("aborts graph-level loops after the configured superstep limit", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "loop-graph" },
      state: { channels: { n: { type: "number", default: 0 } } },
      nodes: [
        {
          id: "tick",
          type: "function",
          with: {
            fn: "inc",
            input: { n: "{{ state.n }}" },
            output: { to: "n" },
          },
        },
      ],
      edges: [
        { from: "START", to: "tick" },
        { from: "tick", to: "tick" },
      ],
      runtime: { checkpoint: { enabled: false }, recursionLimit: 3 },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error?.message?.toLowerCase()).toMatch(/recursion|limit/);
  });
});
