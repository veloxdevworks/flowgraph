import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { registry } from "../registry.js";
import { loadGraphImports } from "./load-imports.js";
import { validateSpec } from "../loader.js";
import { buildStateAnnotation } from "./state-annotation.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const pluginPath = path.join(__dirname, "fixtures", "reducers-plugin.ts");

const specWithImport = (): GraphSpec =>
  ({
    metadata: { name: "import-reducers" },
    imports: [{ reducers: pluginPath }],
    state: { channels: { items: { type: "array", reducer: "custom:uniqueById" } } },
    nodes: [],
    edges: [{ from: "START", to: "END" }],
  }) as unknown as GraphSpec;

describe("loadGraphImports — reducers", () => {
  it("loads reducers from default export record", async () => {
    const spec = specWithImport();
    await loadGraphImports(spec, { cwd: __dirname });
    expect(registry.getReducer("uniqueById")).toBeTypeOf("function");
    expect(() => buildStateAnnotation(spec)).not.toThrow();
  });

  it("validateSpec passes after imports load custom reducer", async () => {
    const spec = specWithImport();
    await loadGraphImports(spec, { cwd: __dirname });
    const diags = validateSpec(spec);
    expect(diags.filter((d) => d.code === "UNREGISTERED_REDUCER")).toHaveLength(0);
  });

  it("validateSpec errors on custom reducer when imports not loaded", () => {
    const spec = {
      metadata: { name: "no-import" },
      state: { channels: { items: { type: "array", reducer: "custom:notRegisteredReducer_xyz" } } },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
    } as unknown as GraphSpec;

    const diags = validateSpec(spec);
    expect(diags.some((d) => d.code === "UNREGISTERED_REDUCER")).toBe(true);
  });
});
