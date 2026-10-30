/**
 * Run-scoped issue log.
 *
 * Every `ctx.issue()` appends one JSON line under
 * `<workspace>/.flowgraph/runs/<threadId|runId>/issues.jsonl`.
 * The key prefers `threadId` so HITL resume cycles accumulate in one file.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runScopedKey, sanitizeRunKey } from "./run-key.js";

export type RunIssueSeverity = "warning" | "error";

export type RunIssue = {
  code: string;
  severity: RunIssueSeverity;
  message: string;
  impact?: string | undefined;
  remediation?: string | undefined;
  nodeId?: string | undefined;
  nodeType?: string | undefined;
  detail?: Record<string, unknown> | undefined;
  raisedAt: string;
};

/** Well-known issue codes used by built-in nodes. */
export const ISSUE_CODE = {
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  CAPTURE_FAILED: "CAPTURE_FAILED",
  STEP_SKIPPED: "STEP_SKIPPED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  MAX_STEPS: "MAX_STEPS",
  ROUTE_EVAL_ERROR: "ROUTE_EVAL_ERROR",
  ERROR_SWALLOWED: "ERROR_SWALLOWED",
  AGENT_REPORTED: "AGENT_REPORTED",
  MEMORY_RECALL_FAILED: "MEMORY_RECALL_FAILED",
  CONTEXT_OVER_BUDGET: "CONTEXT_OVER_BUDGET",
  CONTEXT_SUMMARY_FAILED: "CONTEXT_SUMMARY_FAILED",
  CONTEXT_HISTORY_READ_ONLY: "CONTEXT_HISTORY_READ_ONLY",
} as const;

export type IssueInput = Omit<RunIssue, "raisedAt"> & { raisedAt?: string };

export const ISSUES_CHANNEL_CAP = 200;

export function issueDedupeKey(issue: Pick<RunIssue, "nodeId" | "code" | "message">): string {
  return `${issue.nodeId ?? ""}|${issue.code}|${issue.message}`;
}

export function dedupeIssues(issues: RunIssue[]): RunIssue[] {
  const seen = new Set<string>();
  const out: RunIssue[] = [];
  for (const issue of issues) {
    const key = issueDedupeKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

export function runIssuesPath(workspace: string, key: string): string {
  const safe = sanitizeRunKey(key);
  return join(workspace, ".flowgraph", "runs", safe, "issues.jsonl");
}

export function appendRunIssue(workspace: string, key: string, issue: RunIssue): void {
  const path = runIssuesPath(workspace, key);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(issue)}\n`, "utf8");
}

export function readRunIssues(workspace: string, key: string): RunIssue[] {
  const path = runIssuesPath(workspace, key);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: RunIssue[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RunIssue;
      if (parsed && typeof parsed === "object" && typeof parsed.code === "string") {
        out.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return dedupeIssues(out);
}

export const runIssuesKey = runScopedKey;

export function stampIssue(
  input: IssueInput,
  defaults: { nodeId?: string | undefined; nodeType?: string | undefined },
): RunIssue {
  return {
    code: input.code,
    severity: input.severity,
    message: input.message,
    raisedAt: input.raisedAt ?? new Date().toISOString(),
    ...(input.impact ? { impact: input.impact } : {}),
    ...(input.remediation ? { remediation: input.remediation } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    nodeId: input.nodeId ?? defaults.nodeId,
    nodeType: input.nodeType ?? defaults.nodeType,
  };
}
