import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { GraphSpecSchema } from "@flowgraph/spec";
import { validateSpec } from "./loader.js";
function blocks(file: string): unknown[] {
  const text = readFileSync(resolve(import.meta.dirname, "../../../docs", file), "utf8");
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => {
    try {
      return parse(m[1]!);
    } catch {
      return undefined;
    }
  });
}
it("validates the documented script, form and HTTP transcript node examples", () => {
  const examples = blocks("03-node-types.md");
  const nodes = examples
    .flatMap((value) =>
      Array.isArray(value)
        ? value
        : value && typeof value === "object" && "nodes" in value
          ? (value as { nodes: unknown[] }).nodes
          : [],
    )
    .filter((node): node is Record<string, unknown> => !!node && typeof node === "object");
  for (const id of ["greet", "intake", "http-transcript-tool"]) {
    const node = nodes.find(
      (node) => node.id === id && (id !== "greet" || node.type === "script"),
    )!;
    expect(node).toBeTruthy();
    const output = (node.with as { output?: { to?: string } })?.output?.to;
    const graph = GraphSpecSchema.parse({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "docs" },
      state: { channels: output ? { [output]: { type: "object" } } : {} },
      nodes: [node],
      edges: [
        { from: "START", to: id },
        { from: id, to: "END" },
      ],
    });
    expect(
      validateSpec(graph).filter((d) => d.severity === "error"),
      id,
    ).toEqual([]);
  }
});
it("parses the documented YAML budget as numeric values", () => {
  const budget = blocks("06-events-and-hooks.md").find(
    (value) =>
      !!value &&
      typeof value === "object" &&
      "runtime" in value &&
      (value as { runtime: { budget?: unknown } }).runtime?.budget,
  ) as { runtime: unknown };
  expect(budget).toBeTruthy();
  const spec = GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "budget-doc" },
    nodes: [],
    edges: [],
    runtime: budget.runtime,
  });
  expect(spec.runtime?.budget?.maxTokens).toBe(2000000);
});
