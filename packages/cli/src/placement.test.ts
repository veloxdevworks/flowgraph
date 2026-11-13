import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph, loadGraph, PlacementUnsatisfiedError } from "@flowgraph/core";
import { loadTargetsFile, localHostLabels, placementCompileOptions, placementLines } from "./placement.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(files: Record<string, string>): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "fg-cli-targets-"));
  dirs.push(d);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(d, name)), { recursive: true });
    await fs.writeFile(path.join(d, name), content);
  }
  return d;
}

describe("--targets file", () => {
  it("parses YAML and JSON topologies", async () => {
    const d = await tmp({
      "t.yaml": "targets:\n  studio-pc:\n    url: https://studio-pc.lan:8787\n    token: env:STUDIO_PC_TOKEN\nlocal:\n  labels: [app:blender]\n",
      "t.json": JSON.stringify({ targets: { a: { url: "http://a.test" } } }),
    });
    const y = await loadTargetsFile("t.yaml", d);
    expect(y.diagnostics).toEqual([]);
    expect(y.topology?.targets?.["studio-pc"]?.url).toBe("https://studio-pc.lan:8787");
    expect((await loadTargetsFile("t.json", d)).topology?.targets?.a?.url).toBe("http://a.test");
  });

  it("reports unreadable and invalid files as diagnostics", async () => {
    const d = await tmp({ "bad.yaml": "targets:\n  1bad: { url: http://x.test }\n", "junk.yaml": "targets: [unclosed\n" });
    expect((await loadTargetsFile("missing.yaml", d)).diagnostics[0]?.code).toBe("TOPOLOGY_UNREADABLE");
    expect((await loadTargetsFile("bad.yaml", d)).diagnostics[0]?.code).toBe("TOPOLOGY_INVALID");
    expect((await loadTargetsFile("junk.yaml", d)).diagnostics[0]?.code).toBe("TOPOLOGY_INVALID");
  });

  it("local labels are built-ins plus configured labels whose check passes", async () => {
    const labels = await localHostLabels({
      local: { labels: { "app:ok": { check: [process.execPath, "-e", "0"] }, "app:bad": { check: [process.execPath, "-e", "process.exit(3)"] }, "site:x": {} } },
    });
    expect(labels).toContain("app:ok");
    expect(labels).toContain("site:x");
    expect(labels).not.toContain("app:bad");
    expect(labels.some((l) => l.startsWith("os:"))).toBe(true);
  });

  it("formats one placement line per placed node", () => {
    expect(
      placementLines([
        { nodeId: "character", kind: "remote", target: "studio-pc", required: ["os:windows", "app:cc5"], candidates: [] },
        { nodeId: "up", kind: "local", target: "local", required: ["gpu:nvidia"], candidates: [] },
      ]),
    ).toEqual(["placement: character → studio-pc (os:windows, app:cc5)", "placement: up → local (gpu:nvidia)"]);
  });

  it("an unsatisfiable placement throws PlacementUnsatisfiedError from compile with the topology wired in", async () => {
    const d = await tmp({
      "child.graph.yaml": "apiVersion: flowgraph/v1\nkind: Graph\nmetadata: { name: child }\nnodes:\n  - { id: s, type: shell, with: { command: 'true' } }\nedges: [ { from: START, to: s }, { from: s, to: END } ]\n",
      "g.graph.yaml":
        "apiVersion: flowgraph/v1\nkind: Graph\nmetadata: { name: g }\nnodes:\n  - { id: place, type: subgraph, uses: ./child.graph.yaml, runsOn: [app:nope] }\nedges: [ { from: START, to: place }, { from: place, to: END } ]\n",
    });
    const { spec } = await loadGraph("g.graph.yaml", { cwd: d });
    const placement = await placementCompileOptions(spec!, { targets: {} }, { graphDir: d, subgraphAliases: {}, loadGraph });
    expect(placement.loadChild?.("./child.graph.yaml")?.metadata.name).toBe("child");
    const err = await compileGraph(spec!, { cwd: d, placement }).catch((e) => e);
    expect(err).toBeInstanceOf(PlacementUnsatisfiedError);
    expect(err.message).toContain('node "place" needs');
    expect(err.message).toContain("app:nope");
  });
});
