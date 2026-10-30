/**
 * Cheap PATH lookup for required binaries (`which` / `where`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function checkBinOnPath(name: string): Promise<boolean> {
  if (!name || /[\s;|&<>]/.test(name)) return false;
  try {
    if (process.platform === "win32") {
      await execFileAsync("where", [name]);
    } else {
      await execFileAsync("which", [name]);
    }
    return true;
  } catch {
    return false;
  }
}

export function toolNotFoundMessage(bin: string, extra?: string): string {
  return extra
    ? `required binary "${bin}" was not found on PATH: ${extra}`
    : `required binary "${bin}" was not found on PATH`;
}

export function isMissingBinaryError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\bnot found\b/i.test(msg) || /\bENOENT\b/.test(msg);
}
