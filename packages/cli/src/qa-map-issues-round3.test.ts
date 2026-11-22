import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("PLAT-396: --fail-on-issues fails for swallowed map items while retaining successful rows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "fg-map-issues-cli-"));
  try {
    writeFileSync(join(cwd, "flow.yaml"), JSON.stringify({
      apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "map-issues-cli" },
      state: { channels: { rows: { type: "array", default: ["rice", "BAD:expired", "beans"] }, cleaned: { type: "array" } } },
      nodes: [{ id: "cleanup", type: "map", with: {
        over: "{{ state.rows }}", as: "row", concurrency: 2,
        node: { type: "shell", on: { error: "continue" }, with: {
          command: process.execPath,
          args: ["-e", "const row = process.argv[1]; if (row.startsWith('BAD:')) throw new Error('invalid pantry row'); process.stdout.write(row);", "{{ row }}"],
        } }, collect: { map: { cleaned: "{{ result.stdout }}" } },
      } }],
      edges: [{ from: "START", to: "cleanup" }, { from: "cleanup", to: "END" }],
      runtime: { checkpoint: { backend: "memory" } },
    }));
    const bin = resolve(import.meta.dirname, "../dist/bin.js");
    for (const failOnIssues of [false, true]) {
      const thread = failOnIssues ? "strict" : "permissive";
      const result = spawnSync(process.execPath, [bin, "run", "flow.yaml", "--thread", thread, "--json", ...(failOnIssues ? ["--fail-on-issues"] : [])], { cwd, encoding: "utf8", timeout: 20_000 });
      expect(result.status, result.stderr).toBe(failOnIssues ? 1 : 0);
      const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(events.find(event => event.type === "run.end")?.data.state.cleaned).toEqual(["rice", "beans"]);
      expect(events).toContainEqual(expect.objectContaining({ type: "run.issue", data: expect.objectContaining({ code: "ERROR_SWALLOWED", nodeId: "cleanup[1]" }) }));
      const issues = readFileSync(join(cwd, ".flowgraph", "runs", thread, "issues.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(issues).toEqual([expect.objectContaining({ code: "ERROR_SWALLOWED", nodeId: "cleanup[1]", impact: expect.stringContaining("Failed items have no collected value") })]);
      if (failOnIssues) expect(result.stderr).toContain("--fail-on-issues");
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 50_000);
