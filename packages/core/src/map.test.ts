import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

beforeAll(() => {
  registerFunction("double", (input) => {
    const n = (input as { n?: number }).n ?? 0;
    return n * 2;
  });
  registerFunction("sum", (input) => {
    const arr = (input as { values?: number[] }).values ?? [];
    return arr.reduce((a, b) => a + b, 0);
  });
});

describe("map node — fan-out / fan-in", () => {
  it("runs an inner node per item and collects results", async () => {
    const spec = {
      metadata: { name: "map-graph" },
      state: { channels: { numbers: { type: "array" }, doubled: { type: "array" }, total: { type: "number" } } },
      nodes: [
        {
          id: "map-double",
          type: "map",
          with: {
            over: "{{ state.numbers }}",
            as: "n",
            concurrency: 2,
            node: { type: "function", with: { fn: "double", input: { n: "{{ item.n }}" }, output: { to: "value" } } },
            collect: { to: "doubled" },
          },
        },
        {
          id: "sum-doubled",
          type: "function",
          with: { fn: "sum", input: { values: "{{ state.doubled }}" }, output: { to: "total" } },
        },
      ],
      edges: [
        { from: "START", to: "map-double" },
        { from: "map-double", to: "sum-doubled" },
        { from: "sum-doubled", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { numbers: [1, 2, 3, 4] } });
    expect(r.status).toBe("completed");
    expect(r.state["doubled"]).toEqual([2, 4, 6, 8]);
    expect(r.state["total"]).toBe(20);
  });
});
