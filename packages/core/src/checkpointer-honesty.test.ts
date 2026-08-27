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
});
