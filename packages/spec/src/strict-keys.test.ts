import { describe, it, expect } from "vitest";
import { GraphSpecSchema, diagnosticsFromZodIssues, editDistance, suggestKey } from "./index.js";

const base = (over: Record<string, unknown> = {}) => ({
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "g" },
  nodes: [{ id: "character", type: "shell", with: { command: "echo" } }],
  edges: [],
  ...over,
});

function diags(spec: unknown) {
  const r = GraphSpecSchema.safeParse(spec);
  if (r.success) return [];
  return diagnosticsFromZodIssues(r.error.issues, spec);
}

describe("unknown keys are rejected (UNKNOWN_FIELD)", () => {
  it("accepts a valid graph, including runsOn", () => {
    const spec = base({
      nodes: [{ id: "character", type: "shell", runsOn: ["os:windows"], with: { command: "echo" } }],
    });
    expect(GraphSpecSchema.safeParse(spec).success).toBe(true);
    expect(diags(spec)).toEqual([]);
  });

  it("reports an unknown key at the graph root", () => {
    const d = diags(base({ extras: 1 }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", code: "UNKNOWN_FIELD", path: "extras" });
    expect(d[0]!.message).toContain('Unknown field "extras" on the graph.');
    expect(d[0]!.message).toContain("upgrade flowgraph");
    expect(d[0]!.message).not.toContain("Did you mean");
  });

  it("reports an unknown key on a node, one diagnostic per key", () => {
    const d = diags(
      base({ nodes: [{ id: "character", type: "shell", zzzTop: 1, qqqBottom: 2 }] }),
    );
    expect(d.map((x) => x.path).sort()).toEqual(["nodes.character.qqqBottom", "nodes.character.zzzTop"]);
    expect(d.every((x) => x.code === "UNKNOWN_FIELD" && x.severity === "error")).toBe(true);
    expect(d[0]!.message).toContain('on node "character"');
  });

  it("suggests the closest known key within edit distance 2", () => {
    const d = diags(base({ nodes: [{ id: "character", type: "shell", runOn: ["os:windows"] }] }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ code: "UNKNOWN_FIELD", path: "nodes.character.runOn" });
    expect(d[0]!.message).toBe(
      'Unknown field "runOn" on node "character". Did you mean "runsOn"? If this graph was written for a newer flowgraph, upgrade flowgraph.',
    );
  });

  it("suggests for graph-root typos too", () => {
    const d = diags(base({ edge: [] }));
    expect(d[0]!.message).toContain('Did you mean "edges"?');
  });

  it("reports unknown keys inside an inline subgraph spec", () => {
    const d = diags(
      base({
        nodes: [
          {
            id: "parent",
            type: "subgraph",
            spec: {
              apiVersion: "flowgraph/v1",
              kind: "Graph",
              metadata: { name: "child" },
              nodes: [{ id: "inner", type: "shell", runOn: ["x"] }],
              edges: [],
              bogus: true,
            },
          },
        ],
      }),
    );
    const paths = d.map((x) => x.path).sort();
    expect(paths).toEqual(["nodes.parent.spec.bogus", "nodes.parent.spec.nodes.inner.runOn"]);
    expect(d.every((x) => x.code === "UNKNOWN_FIELD")).toBe(true);
  });

  it("keeps other schema errors as SCHEMA_ERROR", () => {
    const d = diags(base({ nodes: [{ id: "1bad", type: "shell" }] }));
    expect(d[0]!.code).toBe("SCHEMA_ERROR");
  });

  it("does not make metadata or with stricter", () => {
    const spec = base({
      metadata: { name: "g", extra: 1 },
      nodes: [{ id: "n", type: "shell", with: { anything: 1 } }],
    });
    expect(GraphSpecSchema.safeParse(spec).success).toBe(true);
  });
});

describe("suggestKey", () => {
  it("measures edit distance", () => {
    expect(editDistance("runOn", "runsOn")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
  });
  it("returns nothing beyond distance 2", () => {
    expect(suggestKey("completely", ["runsOn", "retry"])).toBeUndefined();
  });
});
