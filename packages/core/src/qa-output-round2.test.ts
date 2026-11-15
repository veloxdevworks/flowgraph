import { expect, it } from "vitest";
import { GraphSpecSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
registerFunction("output-shape-item", input => input);

const graph = (node: unknown) => GraphSpecSchema.parse({
  apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "output-shapes" },
  state: { channels: { items: { type: "array", default: [1,2] }, rows: { type: "array" } } },
  nodes: [node], edges: [{ from: "START", to: "work" }, { from: "work", to: "END" }],
});
it("PLAT-379: serializes a whole-template object as one argv argument", async () => {
  const g = await compileGraph(graph({ id: "work", type: "shell", with: {
    command: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", "{{ {a: state.items} }}"],
  }}));
  const result = await g.run();
  expect(result.status).toBe("completed");
  expect((result.state.outputs as any).work.json).toEqual({ a: [1,2] });
});
it.each([
  { value: "{{ result.n }}" },
  { value: "{{ result.n }}", twice: "{{ result.n * 2 }}" },
])("PLAT-380: preserves declared map keys without an outputs wrapper: %j", async (map) => {
  const g = await compileGraph(graph({ id: "work", type: "map", with: {
    over: "{{ state.items }}", as: "n", node: { type: "function", with: {
      fn: "output-shape-item", input: { n: "{{ item.n }}" }, output: { map },
    }}, collect: { to: "rows" },
  }}));
  const result = await g.run();
  expect(result.status).toBe("completed");
  expect(result.state.rows).toEqual([1,2].map(n => Object.keys(map).length === 1 ? {value:n} : {value:n,twice:n*2}));
});
