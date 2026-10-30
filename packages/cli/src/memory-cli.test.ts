import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openSqliteBackend } from "@flowgraph/checkpoint-sqlite";

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(graph: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fg-cli-mem-"));
  dirs.push(d);
  fs.writeFileSync(path.join(d, "g.graph.yaml"), graph);
  return d;
}

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FLOWGRAPH_ORG: "acme", FLOWGRAPH_PROJECT: "acme/web", FLOWGRAPH_USER: "dev@acme.test", NO_COLOR: "1" },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const counter = (backend: string, extra = "") => `apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: deploy-counter
state:
  channels:
    count: { type: object }
nodes:
  - id: bump
    type: memory
    with:
      op: increment
      scope: project
      key: deploys
      field: n
      output: { to: count }
edges:
  - { from: START, to: bump }
  - { from: bump, to: END }
runtime:
  checkpoint:
    backend: ${backend}
  memory: {}${extra}
`;

describe("flowgraph CLI memory", () => {
  it("runtime.memory on sqlite persists across separate CLI processes", async () => {
    const d = project(counter("sqlite"));
    for (let i = 0; i < 3; i++) {
      const r = cli(d, "run", "g.graph.yaml");
      expect(r.code, r.out).toBe(0);
    }
    const b = await openSqliteBackend(path.join(d, ".flowgraph", "checkpoints.db"));
    try {
      const t = { org: "acme", project: "acme/web", graph: "", usr: "", subjectType: "", subjectKey: "" };
      expect((await b.memory.get(t, "deploys"))?.value).toEqual({ n: 3 });
    } finally {
      b.close();
    }
  }, 120_000);

  it("validate and run reject memory on a backend the CLI cannot store it in", () => {
    const d = project(counter("postgres"));
    const v = cli(d, "validate", "g.graph.yaml");
    expect(v.code).not.toBe(0);
    expect(v.out).toMatch(/MEMORY_BACKEND_UNAVAILABLE/);
    const r = cli(d, "run", "g.graph.yaml");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/cannot store runtime\.memory in a postgres checkpointer/);
  }, 60_000);

  it("validate flags runtime.memory without a durable checkpointer", () => {
    const d = project(counter("memory"));
    const v = cli(d, "validate", "g.graph.yaml");
    expect(v.code).not.toBe(0);
    expect(v.out).toMatch(/MEMORY_BACKEND_UNAVAILABLE/);
  }, 60_000);

  it("a memory node needs runtime.memory; the runtime.store alias alone is not enough", () => {
    const d = project(counter("sqlite").replace("  memory: {}", "  store:\n    backend: sqlite"));
    const v = cli(d, "validate", "g.graph.yaml");
    expect(v.out).toMatch(/MEMORY_NOT_CONFIGURED/);
    expect(v.out).not.toMatch(/MEMORY_BACKEND_UNAVAILABLE/);
  }, 60_000);
});
