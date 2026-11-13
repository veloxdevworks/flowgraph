import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileGraph, loadGraph } from "@flowgraph/core";
import { openSqliteBackend } from "@flowgraph/checkpoint-sqlite";

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const PARALLEL = `apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: parallel-gates
state:
  channels:
    gateA: { type: object }
    gateB: { type: object }
nodes:
  - id: gate-a
    type: hitl
    with: { mode: approve, message: "A?", output: { to: gateA } }
  - id: gate-b
    type: hitl
    with: { mode: question, message: "B?", output: { to: gateB } }
edges:
  - { from: START, to: [gate-a, gate-b] }
  - { from: gate-a, to: END }
  - { from: gate-b, to: END }
runtime:
  checkpoint: { enabled: true, backend: sqlite }
  hitl: { onInterrupt: fail }
`;

describe("flowgraph resume with several pending interrupts", () => {
  it("refuses an unkeyed --resume value and leaves both gates pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-cli-resume-map-"));
    dirs.push(dir);
    const graphPath = path.join(dir, "g.graph.yaml");
    fs.writeFileSync(graphPath, PARALLEL);
    const backend = await openSqliteBackend({ path: path.join(dir, ".flowgraph", "checkpoints.db") });
    try {
      const { spec } = await loadGraph(graphPath, { cwd: dir });
      const compiled = await compileGraph(spec!, { cwd: dir, checkpointer: backend.checkpointer });
      const first = await compiled.run({ threadId: "t1", onInterrupt: "fail" });
      expect(first.status).toBe("interrupted");
      expect(first.interrupts).toHaveLength(2);
    } finally {
      backend.close();
    }

    const result = spawnSync(
      process.execPath,
      [bin, "resume", "g.graph.yaml", "--thread", "t1", "--resume", '{"approved":true}'],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 15_000,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/keyed by interrupt id|RESUME_MAP_REQUIRED/);

    const after = await openSqliteBackend({ path: path.join(dir, ".flowgraph", "checkpoints.db") });
    try {
      const { spec } = await loadGraph(graphPath, { cwd: dir });
      const compiled = await compileGraph(spec!, { cwd: dir, checkpointer: after.checkpointer });
      const snap = await compiled.getState("t1");
      expect(snap?.interrupts).toHaveLength(2);
    } finally {
      after.close();
    }
  });
});
