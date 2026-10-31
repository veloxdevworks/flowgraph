import { describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import "./nodes/index.js";

registerFunction("fg_node_id_noop", () => ({}));

const graphWith = (id: string, inner = false): GraphSpec => {
  const node = { id, type: "function", with: { fn: "fg_node_id_noop" } };
  const nodes = inner
    ? [{ id: "sg", type: "subgraph", spec: { metadata: { name: "child" }, nodes: [node], edges: [{ from: "START", to: id }, { from: id, to: "END" }] }, with: { output: "none" } }]
    : [node];
  const top = inner ? "sg" : id;
  return { metadata: { name: "ids" }, nodes, edges: [{ from: "START", to: top }, { from: top, to: "END" }] } as unknown as GraphSpec;
};

describe("node ids in graphs built in code", () => {
  it("refuses ids that replay and checkpoint keys could confuse", async () => {
    for (const id of ["m[0]", "a[12]", "a,b", "a:b", "a\nb", "a\u0000", "a\u009f"]) {
      await expect(compileGraph(graphWith(id)), JSON.stringify(id)).rejects.toThrow(/Node id/);
      await expect(compileGraph(graphWith(id, true)), `inner ${JSON.stringify(id)}`).rejects.toThrow(/Node id/);
    }
  });

  it("accepts ordinary ids", async () => {
    for (const id of ["a", "step-1", "x_y", "m[x]", "a[0]b", "naïve"]) {
      await expect(compileGraph(graphWith(id)), id).resolves.toBeDefined();
    }
  });
});
