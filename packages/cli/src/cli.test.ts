import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadGraph, validateSpec } from "@veloxdevworks/flowgraph-core";
import { isError } from "@veloxdevworks/flowgraph-spec";
import { migrateSpec } from "./migrate.js";
import { templateFor, listTemplates } from "./templates.js";

describe("migrate", () => {
  it("upgrades apiVersion and kind", () => {
    const raw = `apiVersion: "0.1"\nkind: graph\nmetadata:\n  name: x\n`;
    const r = migrateSpec(raw);
    expect(r.changed).toBe(true);
    expect(r.output).toContain("apiVersion: flowgraph/v1");
    expect(r.output).toContain("kind: Graph");
    expect(r.notes.length).toBe(2);
  });

  it("is a no-op for an up-to-date spec", () => {
    const raw = `apiVersion: flowgraph/v1\nkind: Graph\nmetadata:\n  name: x\n`;
    const r = migrateSpec(raw);
    expect(r.changed).toBe(false);
    expect(r.output).toBe(raw);
  });
});

describe("mcp hub runtime", () => {
  it("resolveInteractiveMcpOAuth respects json and noMcpOauth flags", async () => {
    const { resolveInteractiveMcpOAuth } = await import("./mcp.js");
    expect(resolveInteractiveMcpOAuth({ json: true })).toBe(false);
    expect(resolveInteractiveMcpOAuth({ noMcpOauth: true })).toBe(false);
  });
});

describe("templates", () => {
  it("lists templates including hello as default option", () => {
    expect(listTemplates()).toContain("hello");
    expect(listTemplates()).toContain("minimal");
    expect(listTemplates()).toContain("http");
    expect(listTemplates()).toContain("intelligent");
  });

  it("hello template returns graph plus skill files", () => {
    const result = templateFor("hello", "my-graph");
    expect(result).toBeDefined();
    expect(result!.graphFile).toBe("my-graph.graph.yaml");
    expect(result!.files).toHaveLength(3);
    expect(result!.files.map((f) => f.path)).toEqual([
      "my-graph.graph.yaml",
      "skills/hello/SKILL.md",
      "skills/hello/handler.js",
    ]);
    const graph = result!.files.find((f) => f.path === "my-graph.graph.yaml")!.content;
    expect(graph).toContain("name: my-graph");
    expect(graph).toContain("type: skill");
    expect(graph).toContain("uses: ./skills/hello");
  });

  it("minimal template returns a single graph file", () => {
    const result = templateFor("minimal", "my-graph");
    expect(result).toBeDefined();
    expect(result!.files).toHaveLength(1);
    expect(result!.graphFile).toBe("my-graph.graph.yaml");
  });

  it("http template routes directly to END without code nodes", () => {
    const result = templateFor("http", "api-flow");
    const graph = result!.files[0]!.content;
    expect(graph).not.toContain("type: code");
    expect(graph).toContain("to: END");
  });

  it("intelligent template declares a langchain provider block", () => {
    const result = templateFor("intelligent", "agent");
    const graph = result!.files[0]!.content;
    expect(graph).toContain("providers:");
    expect(graph).toContain("vendor: openai");
    expect(graph).toContain("provider: openai");
    expect(graph).not.toContain("provider: langchain");
  });

  it("returns undefined for an unknown template", () => {
    expect(templateFor("nope", "x")).toBeUndefined();
  });

  it("hello scaffold produces a valid graph spec", async () => {
    const result = templateFor("hello", "demo")!;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-scaffold-"));
    try {
      for (const file of result.files) {
        const dest = path.join(tmp, file.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, file.content);
      }
      const graphPath = path.join(tmp, result.graphFile);
      const { spec, diagnostics } = await loadGraph(graphPath, { cwd: tmp });
      expect(spec).toBeTruthy();
      expect(diagnostics.filter(isError)).toHaveLength(0);
      const lint = validateSpec(spec!);
      expect(lint.filter(isError)).toHaveLength(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
