import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
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

  function wtSpec(nodes: unknown[], runtime: Record<string, unknown> = {}): GraphSpec {
    const ids = (nodes as Array<{ id: string }>).map((n) => n.id);
    const edges = [{ from: "START", to: ids[0] }];
    for (let i = 0; i < ids.length - 1; i++) edges.push({ from: ids[i]!, to: ids[i + 1]! });
    edges.push({ from: ids[ids.length - 1]!, to: "END" });
    return {
      metadata: { name: "wt" },
      state: { channels: { worktree: { type: "object" }, removed: { type: "object" } } },
      nodes,
      edges,
      runtime: { workspace: repo, checkpoint: { enabled: false }, ...runtime },
    } as unknown as GraphSpec;
  }
  const add = (w: Record<string, unknown>) => ({
    id: "isolate",
    type: "worktree",
    with: { action: "add", branch: "farm/demo", path: ".worktrees/demo", output: { to: "worktree" }, ...w },
  });
  const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();

  it.each([
    ["--orphan"],
    ["-b"],
    ["a..b"],
    ["@{-1}"],
    ["has space"],
    ["ends.lock"],
  ])("rejects invalid or option-like branch %j", async (branch) => {
    const r = await (await compileGraph(wtSpec([add({ branch })]), {})).run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error?.message).toMatch(/invalid branch name/);
    expect(await git(repo, "worktree", "list")).not.toContain(".worktrees");
  });

  it.each([["../escape"], ["/tmp/fg-wt-outside"], ["."], ["--force"]])(
    "rejects path %j outside the worktree root",
    async (p) => {
      const r = await (await compileGraph(wtSpec([add({ path: p })]), {})).run({ input: {} });
      expect(r.status).toBe("error");
      expect(r.error?.message).toMatch(/must be inside the worktree root|invalid path/);
    },
  );

  it("rejects a path that escapes the root through a symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fg-wt-out-"));
    try {
      await fs.symlink(outside, path.join(repo, "link"));
      const r = await (await compileGraph(wtSpec([add({ path: "link/demo" })]), {})).run({ input: {} });
      expect(r.status).toBe("error");
      expect(r.error?.message).toMatch(/must be inside the worktree root/);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("honors runtime.worktrees.root", async () => {
    const inRoot = await (
      await compileGraph(wtSpec([add({ path: ".wt/demo" })], { worktrees: { root: ".wt" } }), {})
    ).run({ input: {} });
    expect(inRoot.status).toBe("completed");
    const outside = await (
      await compileGraph(wtSpec([add({ branch: "farm/two", path: ".worktrees/two" })], { worktrees: { root: ".wt" } }), {})
    ).run({ input: {} });
    expect(outside.status).toBe("error");
    expect(outside.error?.message).toMatch(/must be inside the worktree root/);
  });

  it("fails clearly instead of resetting an existing branch, unless reset: true", async () => {
    await git(repo, "checkout", "-q", "-b", "farm/demo");
    await fs.writeFile(path.join(repo, "work.txt"), "precious\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "precious work");
    const precious = await git(repo, "rev-parse", "farm/demo");
    await git(repo, "checkout", "-q", "main");

    const r = await (await compileGraph(wtSpec([add({})]), {})).run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error?.message).toMatch(/branch "farm\/demo" already exists.*reset: true/);
    expect(await git(repo, "rev-parse", "farm/demo")).toBe(precious);

    const r2 = await (await compileGraph(wtSpec([add({ reset: true })]), {})).run({ input: {} });
    expect(r2.status).toBe("completed");
    expect(await git(repo, "rev-parse", "farm/demo")).toBe(await git(repo, "rev-parse", "main"));
  });

  it("force-removes its own worktree but not a foreign dirty one", async () => {
    // Own: added earlier in the same run, then made dirty, then removed.
    registerFunction("wt-dirty", async (input) => {
      await fs.writeFile(path.join(String((input as { p: string }).p), "dirty.txt"), "x");
      return {};
    });
    const own = await (
      await compileGraph(
        wtSpec([
          add({}),
          { id: "dirty", type: "function", with: { fn: "wt-dirty", input: { p: "{{ state.worktree.path }}" } } },
          { id: "drop", type: "worktree", with: { action: "remove", path: ".worktrees/demo", output: { to: "removed" } } },
        ]),
        {},
      )
    ).run({ input: {} });
    expect(own.status).toBe("completed");
    expect((own.state["removed"] as { forced: boolean }).forced).toBe(true);
    expect(await git(repo, "worktree", "list")).not.toContain(".worktrees/demo");

    // Foreign: created outside flowgraph and dirty — git must refuse without --force.
    await git(repo, "worktree", "add", "-q", "-b", "mine", path.join(repo, ".worktrees", "mine"));
    await fs.writeFile(path.join(repo, ".worktrees", "mine", "dirty.txt"), "keep me");
    const foreign = await (
      await compileGraph(wtSpec([{ id: "drop", type: "worktree", with: { action: "remove", path: ".worktrees/mine" } }]), {})
    ).run({ input: {} });
    expect(foreign.status).toBe("error");
    expect(await fs.readFile(path.join(repo, ".worktrees", "mine", "dirty.txt"), "utf8")).toBe("keep me");
  });
});
