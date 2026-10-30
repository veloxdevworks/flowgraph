import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { readRunIssues } from "./runtime/run-issues.js";
import type { NodeRunContext } from "./context.js";

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fg-issue-int-"));
}

describe("ctx.issue integration", () => {
  it("records an issue on disk, in RunResult, and in the reserved channel", async () => {
    registerFunction("raiseIssue", async (_args, ctx: NodeRunContext) => {
      ctx.issue({
        code: "AGENT_REPORTED",
        severity: "warning",
        message: "could not verify",
        impact: "correctness is unverified",
        remediation: "install go and re-run",
      });
      return { ok: true };
    });

    const workspace = mkWorkspace();
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "issue-int" },
      state: { channels: { out: { type: "object" } } },
      nodes: [
        { id: "raise", type: "function", with: { fn: "raiseIssue", output: { to: "out" } } },
      ],
      edges: [
        { from: "START", to: "raise" },
        { from: "raise", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, { cwd: workspace });
    const result = await compiled.run({ threadId: "issue-thread", input: {} });
    expect(result.status).toBe("completed");
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]).toMatchObject({
      code: "AGENT_REPORTED",
      message: "could not verify",
      nodeId: "raise",
      nodeType: "function",
    });

    const onDisk = readRunIssues(workspace, "issue-thread");
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.impact).toBe("correctness is unverified");
  });

  it("dedupes the same issue raised twice in one node", async () => {
    registerFunction("raiseTwice", async (_args, ctx: NodeRunContext) => {
      ctx.issue({ code: "X", severity: "warning", message: "dup" });
      ctx.issue({ code: "X", severity: "warning", message: "dup" });
      return {};
    });

    const workspace = mkWorkspace();
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "issue-dup" },
      nodes: [{ id: "n", type: "function", with: { fn: "raiseTwice" } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, { cwd: workspace });
    const result = await compiled.run({ threadId: "dup-thread", input: {} });
    expect(result.issues).toHaveLength(1);
  });
});
