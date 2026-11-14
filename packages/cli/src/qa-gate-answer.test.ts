import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
it("requires an explicit CLI answer and leaves an unanswered SQLite gate intact", () => {
  dir = mkdtempSync(join(tmpdir(), "fg-gate-answer-"));
  writeFileSync(
    join(dir, "flow.yaml"),
    JSON.stringify({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "answer" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [
        {
          id: "gate",
          type: "hitl",
          with: { mode: "approve", message: "approve", output: { to: "answer" } },
        },
      ],
      edges: [
        { from: "START", to: "gate" },
        { from: "gate", to: "END" },
      ],
      runtime: { checkpoint: { backend: "sqlite", path: "cp.sqlite" } },
    }),
  );
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/bin.js"),
        ...args,
        "flow.yaml",
        "--thread",
        "gate",
        "--json",
      ],
      { cwd: dir, encoding: "utf8", timeout: 25_000 },
    );
  const initial = run("run");
  expect(initial.status, initial.stdout + initial.stderr).toBe(3);
  const missing = run("resume");
  expect(missing.status, missing.stdout + missing.stderr).toBe(1);
  expect(missing.stdout + missing.stderr).toContain("RESUME_VALUE_REQUIRED");
  const explicit = run("resume", "--resume", "false");
  expect(explicit.status, explicit.stdout + explicit.stderr).toBe(0);
  expect(explicit.stdout).toContain('"approved":false');
}, 90_000);
