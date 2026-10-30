import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendRunIssue,
  dedupeIssues,
  issueDedupeKey,
  readRunIssues,
  runIssuesKey,
  runIssuesPath,
  stampIssue,
} from "./run-issues.js";

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fg-issues-"));
}

describe("runIssuesPath / runIssuesKey", () => {
  it("sanitizes the key and nests under .flowgraph/runs", () => {
    expect(runIssuesPath("/ws", "thread/abc")).toBe(
      path.join("/ws", ".flowgraph", "runs", "thread_abc", "issues.jsonl"),
    );
  });

  it("prefers threadId over runId", () => {
    expect(runIssuesKey({ threadId: "t1", runId: "r1" })).toBe("t1");
    expect(runIssuesKey({ runId: "r1" })).toBe("r1");
    expect(runIssuesKey({})).toBe("anonymous");
  });
});

describe("appendRunIssue / readRunIssues", () => {
  it("round-trips entries and skips malformed lines", () => {
    const workspace = mkWorkspace();
    appendRunIssue(workspace, "tid-1", {
      code: "TOOL_NOT_FOUND",
      severity: "warning",
      message: "go missing",
      raisedAt: "2026-01-01T00:00:00.000Z",
      nodeId: "verify",
      impact: "tests never ran",
    });
    appendRunIssue(workspace, "tid-1", {
      code: "CAPTURE_FAILED",
      severity: "warning",
      message: "screenshot failed",
      raisedAt: "2026-01-01T00:00:01.000Z",
      nodeId: "prove",
    });

    const entries = readRunIssues(workspace, "tid-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.code).toBe("TOOL_NOT_FOUND");
    expect(entries[0]?.impact).toBe("tests never ran");
    expect(entries[1]?.nodeId).toBe("prove");
  });

  it("dedupes identical (nodeId, code, message) on read", () => {
    const workspace = mkWorkspace();
    const issue = {
      code: "TOOL_NOT_FOUND",
      severity: "warning" as const,
      message: "go missing",
      raisedAt: "2026-01-01T00:00:00.000Z",
      nodeId: "verify",
    };
    appendRunIssue(workspace, "tid-2", issue);
    appendRunIssue(workspace, "tid-2", { ...issue, raisedAt: "2026-01-01T00:00:02.000Z" });
    expect(readRunIssues(workspace, "tid-2")).toHaveLength(1);
  });

  it("returns [] when missing", () => {
    expect(readRunIssues(mkWorkspace(), "missing")).toEqual([]);
  });
});

describe("stampIssue / issueDedupeKey", () => {
  it("fills defaults without overwriting explicit nodeId", () => {
    const stamped = stampIssue(
      { code: "X", severity: "warning", message: "m", nodeId: "inner" },
      { nodeId: "outer", nodeType: "agent" },
    );
    expect(stamped.nodeId).toBe("inner");
    expect(stamped.nodeType).toBe("agent");
    expect(stamped.raisedAt).toBeTruthy();
  });

  it("builds a stable dedupe key", () => {
    expect(issueDedupeKey({ nodeId: "a", code: "C", message: "m" })).toBe("a|C|m");
  });

  it("dedupeIssues keeps first occurrence", () => {
    const a = {
      code: "C",
      severity: "warning" as const,
      message: "m",
      raisedAt: "t1",
      nodeId: "n",
    };
    expect(dedupeIssues([a, { ...a, raisedAt: "t2" }, { ...a, message: "other" }])).toHaveLength(2);
  });
});
