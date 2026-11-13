import { describe, it, expect } from "vitest";
import {
  GraphSpecSchema,
  NodeSpecSchema,
  PLACEMENT_LABEL_PATTERN,
  normalizeRunsOn,
  generateJsonSchema,
} from "./index.js";

const node = (extra: Record<string, unknown>) => ({ id: "n", type: "shell", ...extra });

describe("runsOn schema", () => {
  it("accepts the array form", () => {
    expect(NodeSpecSchema.safeParse(node({ runsOn: ["os:windows", "app:cc5"] })).success).toBe(true);
  });

  it("accepts the object form", () => {
    const r = NodeSpecSchema.safeParse(
      node({ runsOn: { labels: ["gpu:nvidia"], target: "render-01", fallback: "local", wait: "30m" } }),
    );
    expect(r.success).toBe(true);
  });

  it("is optional", () => {
    expect(NodeSpecSchema.safeParse(node({})).success).toBe(true);
  });

  it("rejects empty label lists", () => {
    expect(NodeSpecSchema.safeParse(node({ runsOn: [] })).success).toBe(false);
    expect(NodeSpecSchema.safeParse(node({ runsOn: { labels: [] } })).success).toBe(false);
  });

  it("rejects malformed labels with a clear message", () => {
    for (const bad of ["windows", "OS:windows", "os:", ":x", "os:-x", "os: windows"]) {
      const r = NodeSpecSchema.safeParse(node({ runsOn: [bad] }));
      expect(r.success, bad).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("namespace:value");
    }
  });

  it("accepts real-world label values", () => {
    for (const ok of ["os:windows", "app:cc5", "plugin:@acme/cc5-nodes", "nodeType:model3d", "flowgraph:0.42"]) {
      expect(PLACEMENT_LABEL_PATTERN.test(ok), ok).toBe(true);
    }
  });

  it("rejects unknown keys, empty target, bad fallback and bad wait in the object form", () => {
    const l = ["os:linux"];
    expect(NodeSpecSchema.safeParse(node({ runsOn: { labels: l, extra: 1 } })).success).toBe(false);
    expect(NodeSpecSchema.safeParse(node({ runsOn: { labels: l, target: "" } })).success).toBe(false);
    expect(NodeSpecSchema.safeParse(node({ runsOn: { labels: l, fallback: "retry" } })).success).toBe(false);
    expect(NodeSpecSchema.safeParse(node({ runsOn: { labels: l, wait: "soon" } })).success).toBe(false);
  });

  it("parses inside a full graph and appears in the generated JSON Schema", () => {
    const g = GraphSpecSchema.safeParse({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "g" },
      nodes: [node({ runsOn: ["os:macos"] })],
      edges: [],
    });
    expect(g.success).toBe(true);
    expect(JSON.stringify(generateJsonSchema())).toContain('"runsOn"');
  });
});

describe("normalizeRunsOn", () => {
  it("turns the array form into an object with fallback error", () => {
    expect(normalizeRunsOn(["os:windows", "app:cc5"])).toEqual({
      labels: ["os:windows", "app:cc5"],
      fallback: "error",
    });
  });

  it("dedupes labels preserving order", () => {
    expect(normalizeRunsOn(["b:x", "a:y", "b:x"]).labels).toEqual(["b:x", "a:y"]);
    expect(normalizeRunsOn({ labels: ["b:x", "b:x", "a:y"] }).labels).toEqual(["b:x", "a:y"]);
  });

  it("defaults fallback and keeps target and wait", () => {
    expect(normalizeRunsOn({ labels: ["gpu:nvidia"], target: "t", wait: "5m" })).toEqual({
      labels: ["gpu:nvidia"],
      target: "t",
      fallback: "error",
      wait: "5m",
    });
    expect(normalizeRunsOn({ labels: ["a:b"], fallback: "local" }).fallback).toBe("local");
  });

  it("omits absent target and wait", () => {
    const n = normalizeRunsOn({ labels: ["a:b"] });
    expect("target" in n).toBe(false);
    expect("wait" in n).toBe(false);
  });
});
