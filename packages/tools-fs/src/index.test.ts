import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSandboxPath, SandboxError } from "./sandbox.js";
import { registerFsTools } from "./index.js";
import { getTool } from "@veloxdevworks/flowgraph-core";

describe("resolveSandboxPath", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-fs-"));
    await fs.writeFile(path.join(tmp, "hello.txt"), "hi", "utf8");
    await fs.mkdir(path.join(tmp, "nested"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("resolves a relative file inside the workspace", async () => {
    const resolved = await resolveSandboxPath(tmp, "hello.txt");
    expect(resolved).toBe(await fs.realpath(path.join(tmp, "hello.txt")));
  });

  it("rejects absolute paths", async () => {
    await expect(resolveSandboxPath(tmp, "/etc/passwd")).rejects.toThrow(SandboxError);
  });

  it("rejects parent traversal", async () => {
    await expect(resolveSandboxPath(tmp, "../outside.txt")).rejects.toThrow(SandboxError);
  });

  it("allows new nested paths when parent exists", async () => {
    const resolved = await resolveSandboxPath(tmp, "nested/new.txt");
    const root = await fs.realpath(tmp);
    expect(resolved).toBe(path.resolve(root, "nested", "new.txt"));
  });
});

describe("registerFsTools", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-fs-tools-"));
    await fs.writeFile(path.join(tmp, "notes.txt"), "hello world", "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("registers read/list by default and performs sandboxed I/O", async () => {
    const { registered } = registerFsTools({ workspaceRoot: tmp });
    expect(registered).toEqual(["fs_read", "fs_list"]);

    const read = getTool("fs_read");
    expect(read).toBeDefined();
    const listed = getTool("fs_list");
    expect(listed).toBeDefined();

    const ctx = { emit: () => {} } as unknown as Parameters<NonNullable<typeof read>["handler"]>[1];
    const content = await read!.handler({ path: "notes.txt" }, ctx);
    expect(content).toMatchObject({ path: "notes.txt", content: "hello world" });

    const listing = await listed!.handler({ path: "." }, ctx);
    expect((listing as { entries: { name: string }[] }).entries.map((e) => e.name)).toContain("notes.txt");
  });

  it("write/edit/delete mutate files inside the workspace", async () => {
    registerFsTools({ workspaceRoot: tmp, operations: ["write", "edit", "delete"] });
    const write = getTool("fs_write")!;
    const edit = getTool("fs_edit")!;
    const del = getTool("fs_delete")!;
    const ctx = { emit: () => {} } as unknown as Parameters<typeof write.handler>[1];

    await write.handler({ path: "out.txt", content: "alpha" }, ctx);
    expect(await fs.readFile(path.join(tmp, "out.txt"), "utf8")).toBe("alpha");

    await edit.handler({ path: "out.txt", find: "alpha", replace: "beta" }, ctx);
    expect(await fs.readFile(path.join(tmp, "out.txt"), "utf8")).toBe("beta");

    await del.handler({ path: "out.txt" }, ctx);
    await expect(fs.stat(path.join(tmp, "out.txt"))).rejects.toThrow();
  });
});
