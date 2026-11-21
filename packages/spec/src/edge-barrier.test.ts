import { describe, expect, it } from "vitest";
import { generateJsonSchema, GraphSpecSchema } from "./index.js";

const base = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "edges" },
  nodes: [
    { id: "a", type: "function" },
    { id: "b", type: "function" },
    { id: "join", type: "function" },
  ],
};

describe("edge from barrier", () => {
  it("accepts a node id or a non-empty list", () => {
    expect(GraphSpecSchema.safeParse({ ...base, edges: [{ from: "a", to: "join" }] }).success).toBe(
      true,
    );
    expect(
      GraphSpecSchema.safeParse({ ...base, edges: [{ from: ["a"], to: "join" }] }).success,
    ).toBe(true);
    const listed = GraphSpecSchema.safeParse({
      ...base,
      edges: [{ from: ["a", "b"], to: "join" }],
    });
    expect(listed.success).toBe(true);
    if (listed.success) expect(listed.data.edges[0]).toEqual({ from: ["a", "b"], to: "join" });
  });

  it("rejects an empty list and duplicate ids", () => {
    const empty = GraphSpecSchema.safeParse({ ...base, edges: [{ from: [], to: "join" }] });
    expect(empty.success).toBe(false);
    if (!empty.success)
      expect(JSON.stringify(empty.error.issues)).toContain("at least one node id");

    const duplicate = GraphSpecSchema.safeParse({
      ...base,
      edges: [{ from: ["a", "a"], to: "join" }],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success)
      expect(JSON.stringify(duplicate.error.issues)).toContain("Duplicate node id");
  });

  it("keeps conditional edges on a single source", () => {
    const ok = GraphSpecSchema.safeParse({
      ...base,
      edges: [{ from: "a", branch: [{ when: "{{ true }}", to: "join" }] }],
    });
    expect(ok.success).toBe(true);
    const listed = GraphSpecSchema.safeParse({
      ...base,
      edges: [{ from: ["a", "b"], branch: [{ default: true, to: "join" }] }],
    });
    expect(listed.success).toBe(false);
  });

  it("publishes the list form in the generated JSON Schema", () => {
    const schema = generateJsonSchema();
    const text = JSON.stringify(schema);
    expect(text).toContain("after every listed source finishes");
    expect(text).toContain('"minItems":1');
    const lists = [...text.matchAll(/"from":\{[^}]*\}/g)].map((match) => match[0]);
    expect(lists.some((entry) => entry.includes("array") || text.includes('"type":"array"'))).toBe(
      true,
    );
  });
});
