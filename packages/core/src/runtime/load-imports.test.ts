import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { registry } from "../registry.js";
import { loadGraphImports, readGraphImportAliases, withUnresolvedImports } from "./load-imports.js";
import { validateSpec } from "../loader.js";
import { buildStateAnnotation } from "./state-annotation.js";
import type { GraphSpec } from "@flowgraph/spec";

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
  it("loads TypeScript .ts import modules via esbuild (not Vitest transpile)", async () => {
    // The fixture is a real .ts file; loadGraphImports must compile it itself
    // so CLI/sidecar (plain Node) can load register.ts the same way.
    expect(pluginPath.endsWith(".ts")).toBe(true);
    const spec = specWithImport();
    await loadGraphImports(spec, { cwd: __dirname });
    expect(registry.getReducer("uniqueById")).toBeTypeOf("function");
  });

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

  it("reads aliases without loading a nodes module", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-import-alias-"));
    const marker = path.join(dir, "import-executed.txt");
    await fs.writeFile(
      path.join(dir, "pwn.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default { type: "pwn-node" };\n`,
    );
    const spec = {
      metadata: { name: "aliases-only" },
      imports: [
        { nodes: "./pwn.mjs" },
        { skill: "./skills/file-bug", as: "file-bug" },
        { reducers: "./register.ts" },
      ],
      nodes: [{ id: "x", type: "pwn-node" }],
      edges: [
        { from: "START", to: "x" },
        { from: "x", to: "END" },
      ],
      state: { channels: { items: { type: "array", reducer: "custom:notLoadedByValidate" } } },
    } as unknown as GraphSpec;
    try {
      expect(readGraphImportAliases(spec).skillAliases).toEqual({
        "file-bug": "./skills/file-bug",
      });
      const diags = withUnresolvedImports(spec, validateSpec(spec));
      expect(existsSync(marker)).toBe(false);
      expect(diags).toContainEqual(
        expect.objectContaining({
          code: "PLUGIN_TYPE_UNRESOLVED",
          severity: "warning",
          message: expect.stringMatching(/\. Validate does not load imports/),
        }),
      );
      expect(diags).toContainEqual(
        expect.objectContaining({
          code: "UNREGISTERED_REDUCER",
          severity: "warning",
          message: expect.stringMatching(/unresolved/),
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("validateSpec errors on custom reducer when imports not loaded", () => {
    const spec = {
      metadata: { name: "no-import" },
      state: { channels: { items: { type: "array", reducer: "custom:notRegisteredReducer_xyz" } } },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
    } as unknown as GraphSpec;

    const diags = withUnresolvedImports(spec, validateSpec(spec));
    expect(diags.some((d) => d.code === "UNREGISTERED_REDUCER" && d.severity === "error")).toBe(
      true,
    );
  });

  it("warns on a mistyped node type when a nodes import is declared", () => {
    const spec = {
      metadata: { name: "typo" },
      imports: [{ nodes: "./plugin.mjs" }],
      nodes: [{ id: "x", type: "shel" }],
      edges: [
        { from: "START", to: "x" },
        { from: "x", to: "END" },
      ],
    } as unknown as GraphSpec;
    const diags = withUnresolvedImports(spec, validateSpec(spec));
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_TYPE_UNRESOLVED",
        severity: "warning",
        path: "nodes.x.type",
      }),
    );
    expect(diags.some((d) => d.code === "UNKNOWN_NODE_TYPE")).toBe(false);
  });

  it("keeps an unknown type an error when no nodes import is declared", () => {
    const spec = {
      metadata: { name: "typo" },
      nodes: [{ id: "x", type: "shel" }],
      edges: [
        { from: "START", to: "x" },
        { from: "x", to: "END" },
      ],
    } as unknown as GraphSpec;
    const diags = withUnresolvedImports(spec, validateSpec(spec));
    expect(diags).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_NODE_TYPE", severity: "error" }),
    );
  });
});
