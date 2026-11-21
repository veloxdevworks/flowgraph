import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const bin = resolve(import.meta.dirname, "../dist/bin.js");
const graph = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "config-env" },
  config: { vars: { token: "${FG_CLI_UNDECLARED}" } },
  nodes: [{ id: "step", type: "router", with: { routes: { done: { default: true, to: "END" } } } }],
  edges: [
    { from: "START", to: "step" },
    { from: "step", to: "END" },
  ],
};
function cli(...args: string[]) {
  return cliWith({ "g.yaml": graph }, ...args);
}
function cliWith(files: Record<string, unknown>, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "fg-cli-config-env-"));
  dirs.push(dir);
  for (const [name, doc] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(doc));
  }
  return spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000 });
}

describe("CLI undeclared config placeholder", () => {
  it("validate reports it once", () => {
    const result = cli("validate", "g.yaml", "--format", "json");
    expect(result.status, result.stderr).toBe(2);
    const diagnostics = JSON.parse(result.stdout) as Array<{ code: string; path?: string }>;
    expect(diagnostics.filter((d) => d.code === "SECRET_UNDECLARED")).toEqual([
      expect.objectContaining({ code: "SECRET_UNDECLARED", path: "config.vars.token" }),
    ]);
  });

  it("run refuses the graph and reports it once", () => {
    const result = cli("run", "g.yaml");
    const out = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, "");
    expect(result.status, out).toBe(2);
    expect(out.match(/\[SECRET_UNDECLARED\]/g)).toHaveLength(1);
  });

  it("validate keeps identical diagnostics from two file subgraphs, each with its file", () => {
    const step = (id: string) => ({ id, type: "subgraph", uses: `./${id}/child.yaml` });
    const parent = { ...graph, config: undefined, nodes: [step("a"), step("b")], edges: [{ from: "START", to: ["a", "b"] }, { from: "a", to: "END" }, { from: "b", to: "END" }] };
    const result = cliWith({ "g.yaml": parent, "a/child.yaml": graph, "b/child.yaml": graph }, "validate", "g.yaml", "--format", "json");
    const diagnostics = JSON.parse(result.stdout) as Array<{ code: string; path?: string; file?: string }>;
    expect(diagnostics.filter((d) => d.code === "SECRET_UNDECLARED").map((d) => [d.file?.split(/[\\/]/).slice(-2).join("/"), d.path])).toEqual([
      ["a/child.yaml", "config.vars.token"],
      ["b/child.yaml", "config.vars.token"],
    ]);
  });
});
