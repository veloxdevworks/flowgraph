import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("PLAT-399: JSON validation reports unknown node types alongside unknown fields", () => {
  const cwd = mkdtempSync(join(tmpdir(), "fg-combined-validation-"));
  try {
    writeFileSync(
      join(cwd, "combined.graph.yaml"),
      JSON.stringify({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "combined-validation" },
        nodes: [
          { id: "typo", type: "shel", with: { command: "echo typo" } },
          { id: "misplaced", type: "shell", runOn: "local", with: { command: "echo known" } },
        ],
        edges: [
          { from: "START", to: "typo" },
          { from: "typo", to: "misplaced" },
          { from: "misplaced", to: "END" },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/bin.js"),
        "validate",
        "combined.graph.yaml",
        "--format",
        "json",
      ],
      { cwd, encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNKNOWN_FIELD",
          severity: "error",
          path: "nodes.misplaced.runOn",
        }),
        expect.objectContaining({
          code: "UNKNOWN_NODE_TYPE",
          severity: "error",
          path: "nodes.typo.type",
        }),
      ]),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 25_000);
