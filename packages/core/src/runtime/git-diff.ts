/**
 * Collect a git diff (stat + patch) for HITL `review` interrupts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitDiffResult {
  cwd: string;
  base?: string;
  stat: string;
  patch: string;
}

export async function collectGitDiff(opts: {
  cwd: string;
  base?: string;
  paths?: string[];
}): Promise<GitDiffResult> {
  const args = ["diff", "--no-color"];
  if (opts.base) args.push(opts.base);
  if (opts.paths && opts.paths.length > 0) {
    args.push("--", ...opts.paths);
  }
  const statArgs = ["diff", "--stat", "--no-color"];
  if (opts.base) statArgs.push(opts.base);
  if (opts.paths && opts.paths.length > 0) {
    statArgs.push("--", ...opts.paths);
  }

  const [stat, patch] = await Promise.all([
    execGit(opts.cwd, statArgs),
    execGit(opts.cwd, args),
  ]);
  return {
    cwd: opts.cwd,
    ...(opts.base ? { base: opts.base } : {}),
    stat,
    patch,
  };
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr?.trim() || msg}`);
  }
}
