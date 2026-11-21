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
  it("accepts a node id or a list of two or more", () => {
    expect(GraphSpecSchema.safeParse({ ...base, edges: [{ from: "a", to: "join" }] }).success).toBe(
      true,
    );
    const listed = GraphSpecSchema.safeParse({
      ...base,
      edges: [{ from: ["a", "b"], to: "join" }],
    });
    expect(listed.success).toBe(true);
    if (listed.success) expect(listed.data.edges[0]).toEqual({ from: ["a", "b"], to: "join" });
  });

  it("rejects an empty list, a single id, and duplicate ids", () => {
    const empty = GraphSpecSchema.safeParse({ ...base, edges: [{ from: [], to: "join" }] });
    expect(empty.success).toBe(false);
    if (!empty.success)
      expect(JSON.stringify(empty.error.issues)).toContain("at least two node ids");

    const single = GraphSpecSchema.safeParse({ ...base, edges: [{ from: ["a"], to: "join" }] });
    expect(single.success).toBe(false);
    if (!single.success)
      expect(JSON.stringify(single.error.issues)).toContain("at least two node ids");

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
    expect(JSON.stringify(schema)).toContain("after every listed source finishes");
    const lists = barrierFromArrays(schema);
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(list).toMatchObject({ type: "array", minItems: 2, uniqueItems: true });
    }
  });
});

/** Array branches of an edge `from`. A string `from` is not a barrier. */
function barrierFromArrays(schema: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    const props = rec.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      collectArrays((props as Record<string, unknown>).from, found);
    }
    for (const value of Object.values(rec)) visit(value);
  };
  visit(schema);
  return found;
}

function collectArrays(schema: unknown, found: Array<Record<string, unknown>>): void {
  if (schema == null || typeof schema !== "object") return;
  const rec = schema as Record<string, unknown>;
  if (rec.type === "array") {
    found.push(rec);
    return;
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = rec[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) collectArrays(branch, found);
  }
}
