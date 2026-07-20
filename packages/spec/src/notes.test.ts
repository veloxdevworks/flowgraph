import { describe, expect, it } from "vitest";
import { GraphSpecSchema, NodeSpecSchema } from "./schema.js";

describe("NodeSpecSchema notes", () => {
  it("accepts optional notes string", () => {
    const result = NodeSpecSchema.safeParse({
      id: "agent-1",
      type: "agent",
      notes: "Author markdown\n\n- tip",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notes).toBe("Author markdown\n\n- tip");
    }
  });

  it("allows omitting notes", () => {
    const result = NodeSpecSchema.safeParse({ id: "shell-1", type: "shell" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notes).toBeUndefined();
    }
  });

  it("round-trips notes through GraphSpecSchema", () => {
    const result = GraphSpecSchema.safeParse({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "notes-graph" },
      nodes: [{ id: "n1", type: "function", notes: "why this exists", with: { fn: "x" } }],
      edges: [
        { from: "START", to: "n1" },
        { from: "n1", to: "END" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nodes[0]?.notes).toBe("why this exists");
    }
  });
});
