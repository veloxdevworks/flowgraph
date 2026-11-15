import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

it("a rejected gate exits nonzero with its reason while approval still exits zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-fail-terminal-"));
  const bin = resolve(import.meta.dirname, "../dist/bin.js");
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8", timeout: 25000 });
  try {
    writeFileSync(
      join(dir, "flow.yaml"),
      JSON.stringify({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "failure-terminal" },
        nodes: [
          {
            id: "review",
            type: "hitl",
            with: {
              mode: "approve",
              message: "Ship?",
              routes: { approved: "END", rejected: "reject" },
            },
          },
          { id: "reject", type: "fail", with: { reason: "Review rejected by owner" } },
        ],
        edges: [{ from: "START", to: "review" }],
        runtime: { checkpoint: { backend: "sqlite", path: "cp.db" } },
      }),
    );
    for (const approved of [false, true]) {
      const thread = approved ? "accepted" : "rejected";
      const initial = cli(
        "run",
        "flow.yaml",
        "--thread",
        thread,
        "--json",
        "--on-interrupt",
        "fail",
      );
      expect(initial.status, initial.stdout + initial.stderr).toBe(3);
      const result = cli(
        "resume",
        "flow.yaml",
        "--thread",
        thread,
        "--json",
        "--resume",
        JSON.stringify({ approved }),
      );
      expect(result.status, result.stdout + result.stderr).toBe(approved ? 0 : 1);
      if (!approved) {
        const events = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "run.error",
            data: expect.objectContaining({
              code: "FLOW_FAILED",
              reason: "Review rejected by owner",
            }),
          }),
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 110000);
