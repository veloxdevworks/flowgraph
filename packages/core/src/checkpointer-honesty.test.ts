import { describe, it, expect } from "vitest";
import { compileGraph } from "./compiler.js";
import type { GraphSpec } from "@flowgraph/spec";

describe("resolveCheckpointer honesty", () => {
  it("throws when YAML asks for postgres without an instance", async () => {
    const spec = {
      metadata: { name: "pg" },
      nodes: [{ id: "n", type: "function", with: { fn: "missing" } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "postgres" } },
    } as unknown as GraphSpec;

    await expect(compileGraph(spec, {})).rejects.toThrow(/postgres/i);
  });

  it("throws for sqlite without an instance", async () => {
    const spec = {
      metadata: { name: "sq" },
      nodes: [{ id: "n", type: "function", with: { fn: "missing" } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "sqlite" } },
    } as unknown as GraphSpec;

    await expect(compileGraph(spec, {})).rejects.toThrow(/sqlite/i);
  });

  it("honors an explicit checkpointer: \"memory\" override even when YAML asks for sqlite", async () => {
    const spec = {
      metadata: { name: "sq-mem" },
      nodes: [{ id: "n", type: "function", with: { fn: "missing" } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "sqlite" } },
    } as unknown as GraphSpec;

    await expect(compileGraph(spec, { checkpointer: "memory" })).resolves.toBeDefined();
  });
});
