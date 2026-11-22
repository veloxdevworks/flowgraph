import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bin = resolve(import.meta.dirname, "../dist/bin.js");
const crashText = /TypeError|startsWith is not a function|is not iterable|Unknown hook event "undefined"/;

function validate(graph: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "fg-validate-nested-"));
  dirs.push(dir);
  writeFileSync(join(dir, "g.yaml"), JSON.stringify(graph));
  const result = spawnSync(process.execPath, [bin, "validate", "g.yaml", "--format", "json"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  expect(result.status, out).toBe(2);
  expect(out).not.toMatch(crashText);
  const diagnostics = JSON.parse(result.stdout) as Array<{ code?: string; message?: string }>;
  return diagnostics;
}

const head = { apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "g" } };
const echo = { id: "y", type: "shell", with: { command: "echo", args: ["hi"] } };
const childEdges = [{ from: "START", to: "y" }, { from: "y", to: "END" }];

function child(extra: Record<string, unknown> = {}) {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "item" },
    nodes: [echo],
    edges: childEdges,
    ...extra,
  };
}

function graph(node: unknown) {
  return {
    ...head,
    nodes: [node],
    edges: [{ from: "START", to: "m" }, { from: "m", to: "END" }],
  };
}

describe("flowgraph validate reports malformed nested graphs", () => {
  it("reports a map-body hook with no do", () => {
    const diagnostics = validate(graph({
      id: "m",
      type: "map",
      with: { over: "{{ state.items }}", node: { type: "subgraph", spec: child({ runtime: { hooks: [{ on: "node:before" }] } }) } },
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "NODE_CONFIG_ERROR",
      message: expect.stringMatching(/Required/),
    }));
  });

  it("reports a map-body hook whose do is not a string", () => {
    const diagnostics = validate(graph({
      id: "m",
      type: "map",
      with: { over: "{{ state.items }}", node: { type: "subgraph", spec: child({ runtime: { hooks: [{ on: "node:before", do: 5 }] } }) } },
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "NODE_CONFIG_ERROR",
      message: expect.stringMatching(/Expected string, received number/),
    }));
  });

  it("reports a map-body spec with no edges", () => {
    const spec = child();
    delete (spec as { edges?: unknown }).edges;
    const diagnostics = validate(graph({
      id: "m",
      type: "map",
      with: { over: "{{ state.items }}", node: { type: "subgraph", spec } },
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "NODE_CONFIG_ERROR",
      message: expect.stringMatching(/edges: Required/),
    }));
  });

  it("reports an inline subgraph hook with no do", () => {
    const diagnostics = validate({
      ...head,
      nodes: [{ id: "sub", type: "subgraph", spec: child({ runtime: { hooks: [{ on: "node:before" }] } }) }],
      edges: [{ from: "START", to: "sub" }, { from: "sub", to: "END" }],
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "SCHEMA_ERROR",
      message: expect.stringMatching(/Required/),
    }));
  });

  it("reports a non-string edge, node id, node type, and routes", () => {
    const specs = [
      child({ edges: [{ from: 5, to: "y" }] }),
      child({ edges: [{ from: "START", to: 5 }] }),
      child({ nodes: [{ type: "shell", with: { command: "echo", args: ["hi"] } }], edges: [{ from: "START", to: "END" }] }),
      child({ nodes: [{ id: "y", type: 5 }], edges: [{ from: "START", to: "END" }] }),
      child({ nodes: [{ id: "y", type: "router", with: { routes: 5 } }] }),
    ];
    for (const spec of specs) {
      const diagnostics = validate(graph({
        id: "m",
        type: "map",
        with: { over: "{{ state.items }}", node: { type: "subgraph", spec } },
      }));
      expect(diagnostics.some((d) => d.code && d.message)).toBe(true);
    }
  });
});
