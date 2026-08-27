import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileGraph } from "./compiler.js";
import type { GraphSpec } from "@flowgraph/spec";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-wt-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("worktree node + runtime.workspace", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("adds a worktree once and reports path/branch/head", async () => {
    const spec = {
      metadata: { name: "wt" },
      state: { channels: { worktree: { type: "object" } } },
      nodes: [
        {
          id: "isolate",
          type: "worktree",
          with: {
            action: "add",
            branch: "farm/demo",
            path: ".worktrees/demo",
            output: { to: "worktree" },
          },
        },
      ],
      edges: [
        { from: "START", to: "isolate" },
        { from: "isolate", to: "END" },
      ],
      runtime: { workspace: repo, checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const wt = r.state["worktree"] as { path: string; branch: string; head: string };
    expect(wt.branch).toBe("farm/demo");
    expect(wt.path).toContain(".worktrees/demo");
    expect(wt.head).toMatch(/^[0-9a-f]{7,40}$/);
    const stat = await fs.stat(wt.path);
    expect(stat.isDirectory()).toBe(true);
  });
});
