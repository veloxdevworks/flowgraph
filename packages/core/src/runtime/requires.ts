/**
 * Shared `requires` / `onMissingTool` handling for shell, script, and demo.
 */

import { checkBinOnPath, toolNotFoundMessage } from "./which.js";
import { ISSUE_CODE, type IssueInput } from "./run-issues.js";

export type ToolRequire = { bin: string; version?: string | undefined };
export type OnMissingTool = "fail" | "skip";

export async function findMissingBins(requires: ToolRequire[] | undefined): Promise<ToolRequire[]> {
  if (!requires?.length) return [];
  const missing: ToolRequire[] = [];
  for (const req of requires) {
    if (!(await checkBinOnPath(req.bin))) missing.push(req);
  }
  return missing;
}

export function missingToolIssue(
  missing: ToolRequire[],
  opts: { command?: string; skipped: boolean },
): IssueInput {
  const bins = missing.map((m) => m.bin).join(", ");
  const versions = missing
    .filter((m) => m.version)
    .map((m) => `${m.bin} ${m.version}`)
    .join(", ");
  const what = opts.command ? `"${opts.command}"` : "this step";
  return {
    code: ISSUE_CODE.TOOL_NOT_FOUND,
    severity: "warning",
    message: opts.skipped
      ? `skipped ${what}: missing ${bins} on PATH`
      : toolNotFoundMessage(bins),
    impact: opts.skipped
      ? `${what} never ran; its results are unverified.`
      : `${what} failed because a required binary was missing.`,
    remediation: versions
      ? `Install ${versions} and re-run.`
      : `Install ${bins} and ensure it is on PATH, then re-run.`,
    detail: { missing: missing.map((m) => m.bin) },
  };
}

export function spawnMissingToolError(err: unknown, command: string): Error | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") return undefined;
  return new Error(
    `required binary "${command}" was not found on PATH (ENOENT). Install it and re-run.`,
  );
}

export function isCommandNotFoundExit(exitCode: number, stderr: string): boolean {
  return exitCode === 127 || /command not found/i.test(stderr) || /not recognized as an internal or external command/i.test(stderr);
}
