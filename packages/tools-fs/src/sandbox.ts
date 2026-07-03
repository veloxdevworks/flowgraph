import * as fs from "node:fs/promises";
import * as path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Resolve a user-supplied relative path inside a workspace root. */
export async function resolveSandboxPath(workspaceRoot: string, userPath: string): Promise<string> {
  if (!userPath || typeof userPath !== "string") {
    throw new SandboxError("Path is required.");
  }
  if (path.isAbsolute(userPath)) {
    throw new SandboxError(`Path must be relative to the workspace: ${userPath}`);
  }
  if (userPath.includes("\0")) {
    throw new SandboxError("Invalid path.");
  }

  const root = await fs.realpath(path.resolve(workspaceRoot));
  const normalized = path.normalize(userPath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new SandboxError(`Path escapes workspace: ${userPath}`);
  }

  const candidate = path.resolve(root, normalized);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new SandboxError(`Path escapes workspace: ${userPath}`);
  }

  try {
    const real = await fs.realpath(candidate);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new SandboxError(`Path escapes workspace via symlink: ${userPath}`);
    }
    return real;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // New file: ensure parent directory (if any) stays inside the workspace.
    const parent = path.dirname(candidate);
    if (parent === root) return candidate;
    try {
      const parentReal = await fs.realpath(parent);
      if (parentReal !== root && !parentReal.startsWith(root + path.sep)) {
        throw new SandboxError(`Path escapes workspace: ${userPath}`);
      }
    } catch (parentErr) {
      if ((parentErr as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SandboxError(`Parent directory does not exist: ${path.dirname(userPath)}`);
      }
      throw parentErr;
    }
    return candidate;
  }
}
