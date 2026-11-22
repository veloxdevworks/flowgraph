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

/** One CLI smoke. The other malformed shapes are covered by validateSpec. */
describe("validate on a malformed nested graph", () => {
  it("reports a map-body hook with no do as one coded diagnostic", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-validate-nested-"));
    dirs.push(dir);
    writeFileSync(join(dir, "g.yaml"), JSON.stringify({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "g" },
      nodes: [{
        id: "m",
        type: "map",
        with: {
          over: "{{ state.items }}",
          node: {
            type: "subgraph",
            spec: {
              apiVersion: "flowgraph/v1",
              kind: "Graph",
              metadata: { name: "item" },
              nodes: [{ id: "y", type: "shell", with: { command: "echo", args: ["hi"] } }],
              edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }],
              runtime: { hooks: [{ on: "node:before" }] },
            },
          },
        },
      }],
      edges: [{ from: "START", to: "m" }, { from: "m", to: "END" }],
    }));
    const run = spawnSync(process.execPath, [bin, "validate", "g.yaml", "--format", "json"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
    });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(run.status, out).toBe(2);
    expect(out).not.toMatch(/TypeError|startsWith is not a function|is not iterable|Unknown hook event "undefined"/);
    const diagnostics = JSON.parse(run.stdout) as Array<{ severity: string; code: string; path?: string; message: string }>;
    expect(diagnostics.filter((d) => d.severity === "error").map((d) => ({ code: d.code, path: d.path, message: d.message }))).toEqual([
      {
        code: "NODE_CONFIG_ERROR",
        path: "nodes.m.with.node.spec.runtime.hooks.0.do",
        message: "node.spec.runtime.hooks.0.do: Required",
      },
    ]);
  });
});
