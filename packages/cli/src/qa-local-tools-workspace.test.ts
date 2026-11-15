import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { getTool } from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";
import { registerLocalTools } from "./local-tools.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("scopes local filesystem tools to the recovered execution root without applying runtime.workspace again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-cli-fs-binding-")); dirs.push(dir);
  const original = join(dir, "original"), later = join(dir, "later");
  await mkdir(join(original, "files"), { recursive: true });
  await mkdir(join(later, "changed", "files"), { recursive: true });
  await writeFile(join(original, "files", "notes.txt"), "original workspace");
  await writeFile(join(later, "changed", "files", "notes.txt"), "wrong workspace");
  const spec = { nodes: [], localTools: { fs: { workspaceRoot: "files", operations: ["read", "write"] } }, runtime: { workspace: "changed" } } as unknown as GraphSpec;
  await registerLocalTools(spec, later, { workspace: original });
  const read = getTool("fs_read")!, write = getTool("fs_write")!;
  const ctx = { emit: () => {} } as unknown as Parameters<typeof read.handler>[1];
  expect(await read.handler({ path: "notes.txt" }, ctx)).toMatchObject({ content: "original workspace" });
  await write.handler({ path: "result.txt", content: "stayed in original" }, ctx);
  expect(await readFile(join(original, "files", "result.txt"), "utf8")).toBe("stayed in original");
  await expect(readFile(join(later, "changed", "files", "result.txt"))).rejects.toThrow();
});

it.each([
  { authoredWorkspace: undefined, explicitWorkspace: undefined },
  { authoredWorkspace: "../authored workspace", explicitWorkspace: undefined },
  { authoredWorkspace: undefined, explicitWorkspace: "selected workspace" },
])("restores CLI filesystem tools after a gate resumed from another cwd (%j)", async ({ authoredWorkspace, explicitWorkspace }) => {
  const dir = await mkdtemp(join(tmpdir(), "fg-cli-resume-fs-")); dirs.push(dir);
  const graphDir = join(dir, "graphs"), originalCwd = join(dir, "original cwd"), laterCwd = join(dir, "later cwd");
  const originalWorkspace = explicitWorkspace ? resolve(originalCwd, explicitWorkspace) : authoredWorkspace ? resolve(graphDir, authoredWorkspace) : originalCwd;
  for (const folder of [graphDir, originalCwd, laterCwd, join(originalWorkspace, "files"), join(laterCwd, "files")]) await mkdir(folder, { recursive: true });
  await writeFile(join(originalWorkspace, "files", "notes.txt"), "original workspace");
  await writeFile(join(laterCwd, "files", "notes.txt"), "wrong workspace");
  const core = pathToFileURL(resolve(import.meta.dirname, "../../core/dist/index.js")).href;
  await writeFile(join(graphDir, "register.mjs"), `
    import { registerFunction, getTool } from ${JSON.stringify(core)};
    registerFunction('qaReadPinnedWorkspace', async (_input, ctx) => {
      const result = await getTool('fs_read').handler({path:'notes.txt'}, ctx);
      await getTool('fs_write').handler({path:'result.txt',content:result.content}, ctx);
      return result.content;
    });
    export default [];
  `);
  const graph = join(graphDir, "flow.yaml");
  await writeFile(graph, JSON.stringify({
    apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "local-tools-recovery" },
    imports: [{ nodes: "./register.mjs" }],
    localTools: { fs: { workspaceRoot: "files", operations: ["read", "write"] } },
    nodes: [
      { id: "gate", type: "hitl", with: { mode: "approve", message: "Continue?" } },
      { id: "work", type: "function", with: { fn: "qaReadPinnedWorkspace" } },
    ],
    edges: [{ from: "START", to: "gate" }, { from: "gate", to: "work" }, { from: "work", to: "END" }],
    runtime: { checkpoint: { backend: "sqlite", path: join(dir, "checkpoints.db") }, ...(authoredWorkspace ? { workspace: authoredWorkspace } : {}) },
  }));
  const bin = resolve(import.meta.dirname, "../dist/bin.js");
  const cli = (mode: string, cwd: string, ...args: string[]) => spawnSync(process.execPath, [bin, mode, graph, "--thread", "fs-binding", "--json", ...args], { cwd, encoding: "utf8", timeout: 20000 });
  const started = cli("run", originalCwd, ...(explicitWorkspace ? ["--workspace", explicitWorkspace] : []));
  expect(started.status, started.stdout + started.stderr).toBe(3);
  const resumed = cli("resume", laterCwd, "--resume", "true");
  expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
  expect(await readFile(join(originalWorkspace, "files", "result.txt"), "utf8")).toBe("original workspace");
  await expect(readFile(join(laterCwd, "files", "result.txt"))).rejects.toThrow();
}, 45000);
