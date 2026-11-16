import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("validate reports a schema typo even when other values in the schema are templated", () => {
  const cwd = mkdtempSync(join(tmpdir(), "fg-contract-validate-"));
  try {
    writeFileSync(
      join(cwd, "form.graph.yaml"),
      JSON.stringify({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "contract-validate" },
        nodes: [
          {
            id: "intake",
            type: "hitl",
            with: {
              mode: "form",
              message: "Fill in",
              schema: {
                type: "object",
                description: "Answers for {{ state.topic }}",
                properties: {
                  title: { tpye: "string" },
                  pick: { enum: "{{ state.options }}" },
                },
              },
            },
          },
        ],
        edges: [
          { from: "START", to: "intake" },
          { from: "intake", to: "END" },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../dist/bin.js"), "validate", "form.graph.yaml", "--format", "json"],
      { cwd, encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status, result.stderr).toBe(2);
    const diags = JSON.parse(result.stdout) as Array<{ code: string; path?: string; message: string }>;
    const schemaDiags = diags.filter((d) => d.path === "nodes.intake.with.schema");
    expect(schemaDiags).toEqual([
      expect.objectContaining({ code: "NODE_CONFIG_ERROR", message: expect.stringContaining('unknown keyword: "tpye"') }),
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 25_000);
