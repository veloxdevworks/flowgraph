import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const bin = resolve(import.meta.dirname, "../dist/bin.js");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fg-cli-qa-load-"));
  dirs.push(dir);
  return dir;
}
const graph = (node: unknown, extra = {}) => ({
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "qa-cli" },
  nodes: [node],
  edges: [
    { from: "START", to: "step" },
    { from: "step", to: "END" },
  ],
  ...extra,
});
function cli(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("PLAT-295 / PLAT-323 / PLAT-337: real CLI", { timeout: 30_000 }, () => {
  it("validates a graph path containing a directory", () => {
    const dir = fixture();
    mkdirSync(join(dir, "graphs"));
    writeFileSync(
      join(dir, "graphs/flow.yaml"),
      JSON.stringify(
        graph({
          id: "step",
          type: "router",
          with: { routes: { done: { default: true, to: "END" } } },
        }),
      ),
    );
    const result = cli(dir, "validate", "graphs/flow.yaml");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each(["validate", "run"])(
    "rejects a self import quickly from %s",
    (command) => {
      const dir = fixture();
      writeFileSync(
        join(dir, "cycle.yaml"),
        JSON.stringify(graph({ id: "step", type: "subgraph", uses: "./cycle.yaml" })),
      );
      const result = cli(dir, command, "cycle.yaml");
      expect(result.status, String(result.error)).toBe(2);
      expect(result.stdout + result.stderr).toMatch(/SUBGRAPH_CYCLE|subgraph.*cycle/i);
    },
    30_000,
  );

  it("detects cycles through a symlink", () => {
    const dir = fixture();
    writeFileSync(
      join(dir, "cycle.yaml"),
      JSON.stringify(graph({ id: "step", type: "subgraph", uses: "./alias.yaml" })),
    );
    symlinkSync("cycle.yaml", join(dir, "alias.yaml"));
    const result = cli(dir, "validate", "cycle.yaml");
    expect(result.status, String(result.error)).toBe(2);
    expect(result.stdout + result.stderr).toMatch(/SUBGRAPH_CYCLE|subgraph.*cycle/i);
  }, 30_000);

  it.each(["ascii", "mermaid"])(
    "includes router and HITL destinations in %s diagrams",
    (format) => {
      const dir = fixture();
      const spec = graph({
        id: "step",
        type: "router",
        with: { routes: { review: { default: true, to: "gate" } } },
      });
      spec.nodes.push({
        id: "gate",
        type: "hitl",
        with: { mode: "approve", routes: { approved: "END", rejected: "END" } },
      });
      writeFileSync(join(dir, "flow.yaml"), JSON.stringify(spec));
      const result = cli(dir, "graph", "flow.yaml", "--format", format);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/step.*(?:→|-->).*gate/);
      expect(result.stdout).toMatch(/gate.*(?:→|-->).*END/);
    },
  );
});
