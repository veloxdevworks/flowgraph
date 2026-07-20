import { describe, expect, it } from "vitest";
import { parseGraphYaml } from "./graph-source.js";

const MINIMAL = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hello
state:
  channels:
    text: { type: string }
nodes:
  - id: echo
    type: function
    with:
      fn: missing
edges:
  - { from: START, to: echo }
  - { from: echo, to: END }
`;

describe("parseGraphYaml", () => {
  it("parses a minimal graph", () => {
    const result = parseGraphYaml(MINIMAL);
    if (!result.spec) {
      throw new Error(result.diagnostics.map((d) => d.message).join("; "));
    }
    expect(result.spec.metadata.name).toBe("hello");
    expect(result.importsStripped).toBe(false);
  });

  it("strips client imports", () => {
    const yaml = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hello
imports:
  - { reducers: "./register.ts" }
state:
  channels:
    text: { type: string }
nodes:
  - id: echo
    type: function
    with:
      fn: missing
edges:
  - { from: START, to: echo }
  - { from: echo, to: END }
`;
    const result = parseGraphYaml(yaml);
    if (!result.spec) {
      throw new Error(result.diagnostics.map((d) => d.message).join("; "));
    }
    expect(result.importsStripped).toBe(true);
    expect(result.spec.imports).toBeUndefined();
  });

  it("rejects invalid yaml", () => {
    const result = parseGraphYaml("::: not yaml");
    expect(result.spec).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
