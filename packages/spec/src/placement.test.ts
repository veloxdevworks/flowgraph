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

  it("accepts the object form without wait", () => {
    const r = NodeSpecSchema.safeParse(
      node({ runsOn: { labels: ["gpu:nvidia"], target: "render-01", fallback: "local" } }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects runsOn.wait and names that queueing is not available", () => {
    const r = NodeSpecSchema.safeParse(
      node({ runsOn: { labels: ["gpu:nvidia"], wait: "30m" } }),
    );
    expect(r.success).toBe(false);
    const issue = r.error?.issues.find((i) => i.path.join(".").endsWith("wait"));
    expect(issue?.message).toContain("runsOn.wait is not supported");
    expect(issue?.message).toContain("matching worker");
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

  it("rejects unknown keys, empty target and bad fallback in the object form", () => {
    const l = ["os:linux"];
    expect(NodeSpecSchema.safeParse(node({ runsOn: { labels: l, extra: 1 } })).success).toBe(false);
    expect(NodeSpecSchema.safeParse(node({ runsOn: { labels: l, target: "" } })).success).toBe(false);
    expect(NodeSpecSchema.safeParse(node({ runsOn: { labels: l, fallback: "retry" } })).success).toBe(false);
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

  it("does not offer runsOn.wait in the generated JSON Schema", () => {
    const schema = generateJsonSchema();
    const runsOnObjects: Array<Record<string, unknown>> = [];
    const walk = (node: unknown): void => {
      if (node == null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const rec = node as Record<string, unknown>;
      const props = rec.properties;
      if (props && typeof props === "object" && !Array.isArray(props)) {
        const fields = props as Record<string, unknown>;
        if ("labels" in fields && "fallback" in fields) runsOnObjects.push(fields);
      }
      for (const value of Object.values(rec)) walk(value);
    };
    walk(schema);
    expect(runsOnObjects.length).toBeGreaterThan(0);
    for (const fields of runsOnObjects) {
      expect(fields).not.toHaveProperty("wait");
    }
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
