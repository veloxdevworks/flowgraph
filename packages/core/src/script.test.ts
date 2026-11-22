import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph } from "./compiler.js";
import { ScriptWithSchema, type GraphSpec } from "@flowgraph/spec";
import { runScriptSandboxed } from "./nodes/script.js";
import { defineProvider } from "./providers/types.js";

function scriptSpec(nodeWith: Record<string, unknown>, node: Record<string, unknown> = {}): GraphSpec {
  return {
    metadata: { name: "script-test" },
    state: {
      channels: {
        out: { type: "object" },
        text: { type: "string" },
        name: { type: "string" },
      },
    },
    nodes: [
      {
        id: "run",
        type: "script",
        ...node,
        with: nodeWith,
      },
    ],
    edges: [
      { from: "START", to: "run" },
      { from: "run", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

const ADD_CODE = `
export default async function(input) {
  return { sum: (input.a ?? 0) + (input.b ?? 0) };
}
`;

describe("ScriptWithSchema", () => {
  it("requires code", () => {
    expect(ScriptWithSchema.safeParse({}).success).toBe(false);
    expect(ScriptWithSchema.safeParse({ code: "" }).success).toBe(false);
    expect(ScriptWithSchema.safeParse({ code: "export default async () => 1" }).success).toBe(true);
  });

  it("accepts permissions and rejects with.timeout", () => {
    const r = ScriptWithSchema.safeParse({
      code: "export default async () => ({})",
      permissions: {
        fsRead: ["/tmp"],
        fsWrite: ["/tmp/out"],
        childProcess: true,
        workerThreads: false,
      },
      input: { x: "{{ state.x }}" },
      env: { MARK: "1" },
    });
    expect(r.success).toBe(true);
    const timed = ScriptWithSchema.safeParse({ code: "export default async () => ({})", timeout: "5s" });
    expect(timed.success).toBe(false);
    if (!timed.success) expect(timed.error.issues[0]?.message).toContain("script with.timeout is not supported");
  });
});

describe("runScriptSandboxed", () => {
  it("runs a default-export function and returns its result", async () => {
    const r = await runScriptSandboxed(ADD_CODE, { input: { a: 2, b: 3 } });
    expect(r.exitCode).toBe(0);
    expect(r.result).toEqual({ sum: 5 });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("denies filesystem write outside the sandbox by default", async () => {
    const target = path.join(os.tmpdir(), `fg-script-deny-${Date.now()}.txt`);
    await expect(
      runScriptSandboxed(
        `
import { writeFileSync } from "node:fs";
export default async function() {
  writeFileSync(${JSON.stringify(target)}, "x");
  return { ok: true };
}
`,
      ),
    ).rejects.toThrow(/Access to this API has been restricted|ERR_ACCESS_DENIED|exited with code/);
  });

  it("allows filesystem write when permissions.fsWrite is set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-allow-"));
    const target = path.join(dir, "out.txt");
    try {
      const r = await runScriptSandboxed(
        `
import { writeFileSync, readFileSync } from "node:fs";
export default async function(input) {
  writeFileSync(input.path, "hello");
  return { text: readFileSync(input.path, "utf8") };
}
`,
        {
          input: { path: target },
          permissions: { fsWrite: [dir], fsRead: [dir] },
        },
      );
      expect(r.result).toEqual({ text: "hello" });
      expect(await fs.readFile(target, "utf8")).toBe("hello");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects bare third-party imports (no node_modules)", async () => {
    await expect(
      runScriptSandboxed(`
import leftPad from "left-pad";
export default async function() { return leftPad("a", 3); }
`),
    ).rejects.toThrow(/Cannot find package|ERR_MODULE_NOT_FOUND|exited with code/);
  });

  it("times out long-running scripts", async () => {
    await expect(
      runScriptSandboxed(
        `export default async function() { await new Promise(r => setTimeout(r, 60_000)); }`,
        { timeoutMs: 200, stopGraceMs: 50 },
      ),
    ).rejects.toThrow(/timed out/);
  }, 10_000);

  it("surfaces thrown errors from the script", async () => {
    await expect(
      runScriptSandboxed(`export default async function() { throw new Error("boom"); }`),
    ).rejects.toThrow(/boom/);
  });

  it("requires a default-export function", async () => {
    await expect(
      runScriptSandboxed(`export const x = 1;`),
    ).rejects.toThrow(/default export must be a function|exited with code/);
  });

  it("passes ctx metadata", async () => {
    const r = await runScriptSandboxed(
      `export default async function(_input, ctx) { return ctx; }`,
      { nodeId: "n1", runId: "r1", threadId: "t1" },
    );
    expect(r.result).toEqual({ nodeId: "n1", runId: "r1", threadId: "t1" });
  });

  it("allows node: builtins", async () => {
    const r = await runScriptSandboxed(`
import { createHash } from "node:crypto";
export default async function(input) {
  return { hex: createHash("sha256").update(String(input.text)).digest("hex") };
}
`, { input: { text: "hi" } });
    expect((r.result as { hex: string }).hex).toHaveLength(64);
  });

  it("persists relative writes under workspace after sandbox cleanup", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-ws-"));
    try {
      const r = await runScriptSandboxed(
        `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export default async function() {
  const path = "outputs/weekly-content.md";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# hello\\n", "utf8");
  return { path };
}
`,
        {
          workspace,
          permissions: { fsWrite: ["outputs"], fsRead: ["outputs"] },
        },
      );
      expect(r.exitCode).toBe(0);
      expect(r.result).toEqual({ path: "outputs/weekly-content.md" });
      const saved = path.join(workspace, "outputs", "weekly-content.md");
      expect(await fs.readFile(saved, "utf8")).toBe("# hello\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("grants a file that does not exist yet without its folder", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-newfile-"));
    try {
      await fs.writeFile(path.join(workspace, "precious.txt"), "keep");
      const r = await runScriptSandboxed(
        `
import { writeFileSync } from "node:fs";
export default async function() {
  writeFileSync("new-output.txt", "created");
  try { writeFileSync("precious.txt", "overwritten"); return { sibling: "written" }; }
  catch (e) { return { sibling: e.code }; }
}
`,
        { workspace, permissions: { fsWrite: ["new-output.txt"] } },
      );
      expect(r.result).toEqual({ sibling: "ERR_ACCESS_DENIED" });
      expect(await fs.readFile(path.join(workspace, "new-output.txt"), "utf8")).toBe("created");
      expect(await fs.readFile(path.join(workspace, "precious.txt"), "utf8")).toBe("keep");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("treats a missing dotted name as a file unless the grant ends with /", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-dotted-"));
    try {
      const r = await runScriptSandboxed(
        `
import { mkdirSync, writeFileSync } from "node:fs";
const tryWrite = (dir) => { try { mkdirSync(dir); writeFileSync(dir + "/a.txt", "x"); return "written"; } catch (e) { return e.code; } };
export default async function() { return { file: tryWrite("data.v2"), dir: tryWrite("data.v3") }; }
`,
        { workspace, permissions: { fsWrite: ["data.v2", "data.v3/"] } },
      );
      expect(r.result).toEqual({ file: "ERR_ACCESS_DENIED", dir: "written" });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("grants a new file in a workspace reached through a symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-link-"));
    try {
      await fs.mkdir(path.join(root, "real"));
      await fs.symlink(path.join(root, "real"), path.join(root, "link"));
      const r = await runScriptSandboxed(
        `
import { writeFileSync } from "node:fs";
export default async function() { writeFileSync("out.txt", "created"); return { ok: true }; }
`,
        { workspace: path.join(root, "link"), permissions: { fsWrite: ["out.txt"] } },
      );
      expect(r.result).toEqual({ ok: true });
      expect(await fs.readFile(path.join(root, "real", "out.txt"), "utf8")).toBe("created");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("grants a folder that does not exist yet without its parent", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-newdir-"));
    try {
      await fs.writeFile(path.join(workspace, "precious.txt"), "keep");
      const r = await runScriptSandboxed(
        `
import { mkdirSync, writeFileSync } from "node:fs";
export default async function() {
  mkdirSync("outputs/nested", { recursive: true });
  writeFileSync("outputs/nested/report.md", "created");
  const tryWrite = (p) => { try { writeFileSync(p, "overwritten"); return "written"; } catch (e) { return e.code; } };
  return { sibling: tryWrite("precious.txt"), prefix: tryWrite("outputs-other.txt") };
}
`,
        { workspace, permissions: { fsWrite: ["outputs"] } },
      );
      expect(r.result).toEqual({ sibling: "ERR_ACCESS_DENIED", prefix: "ERR_ACCESS_DENIED" });
      expect(await fs.readFile(path.join(workspace, "outputs", "nested", "report.md"), "utf8")).toBe("created");
      expect(await fs.readFile(path.join(workspace, "precious.txt"), "utf8")).toBe("keep");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("resolves relative permissions.fsWrite against workspace", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-relperm-"));
    try {
      const r = await runScriptSandboxed(
        `
import { writeFileSync, readFileSync } from "node:fs";
export default async function() {
  writeFileSync("note.txt", "workspace-ok");
  return { text: readFileSync("note.txt", "utf8") };
}
`,
        {
          workspace,
          permissions: { fsWrite: ["."], fsRead: ["."] },
        },
      );
      expect(r.result).toEqual({ text: "workspace-ok" });
      expect(await fs.readFile(path.join(workspace, "note.txt"), "utf8")).toBe("workspace-ok");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("script node", () => {
  it("passes tool arguments by default and preserves explicit input mappings", async () => {
    for (const mapped of [false, true]) {
      const spec = scriptSpec({ code: "export default input => input;", ...(mapped ? { input: { qty: "{{ input.qty }}", unit: "{{ input.from }}" } } : {}) });
      spec.nodes[0]!.id = "convert";
      spec.nodes[0]!.when = "false";
      spec.nodes.push({ id: "assistant", type: "agent", provider: "conversion-test", with: { prompt: "convert cups to ml", tools: [{ node: "convert" }], output: { to: "out" } } } as GraphSpec["nodes"][number]);
      spec.edges = [{ from: "START", to: "convert" }, { from: "convert", to: "assistant" }, { from: "assistant", to: "END" }];
      const provider = defineProvider({
        name: "conversion-test", capabilities: { toolCalling: true, structuredOutput: false, streaming: false },
        async run(_req, ctx) { return { output: await ctx.invokeTool("convert", { qty: 2.5, from: "cups", to: "ml" }), stopReason: "done" }; },
      });
      const result = await (await compileGraph(spec, { providers: [provider] })).run();
      expect(result.status, String(result.error)).toBe("completed");
      expect(result.state.out).toEqual(mapped ? { qty: 2.5, unit: "cups" } : { qty: 2.5, from: "cups", to: "ml" });
    }
  });

  it("runs inline code and maps output", async () => {
    // with.input values are template strings; scripts coerce as needed
    const compiled = await compileGraph(
      scriptSpec({
        code: `
export default async function(input) {
  return { sum: Number(input.a) + Number(input.b) };
}
`,
        input: { a: "2", b: "3" },
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state["out"]).toEqual({ sum: 5 });
  });

  it("renders input templates from state", async () => {
    const compiled = await compileGraph(
      scriptSpec({
        code: `
export default async function(input) {
  return { greeting: "Hello, " + input.name + "!" };
}
`,
        input: { name: "{{ state.name }}" },
        output: { map: { text: "{{ result.greeting }}" } },
      }),
      {},
    );
    const r = await compiled.run({ input: { name: "Ada" } });
    expect(r.status).toBe("completed");
    expect(r.state["text"]).toBe("Hello, Ada!");
  });

  it("passes env into the child process", async () => {
    const compiled = await compileGraph(
      scriptSpec({
        code: `
export default async function() {
  return { mark: process.env.FG_MARK ?? null };
}
`,
        env: { FG_MARK: "marked" },
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state["out"]).toEqual({ mark: "marked" });
  });

  it("fails the node when the script throws", async () => {
    const compiled = await compileGraph(
      scriptSpec({
        code: `export default async function() { throw new Error("nope"); }`,
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
  });

  it("times out long-running scripts", async () => {
    const compiled = await compileGraph(
      scriptSpec({
        code: `export default async function() { await new Promise(r => setTimeout(r, 60_000)); }`,
        output: { to: "out" },
      }, { timeout: "200ms" }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
  }, 10_000);

  it("writes relative paths into the graph workspace (survives sandbox cleanup)", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-node-ws-"));
    try {
      const compiled = await compileGraph(
        scriptSpec({
          code: `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export default async function() {
  const path = "outputs/deliverable.md";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "persist-me\\n", "utf8");
  return { path };
}
`,
          permissions: { fsWrite: ["outputs"], fsRead: ["outputs"] },
          output: { to: "out" },
        }),
        { cwd: workspace },
      );
      const r = await compiled.run({ input: {} });
      expect(r.status).toBe("completed");
      expect(r.state["out"]).toEqual({ path: "outputs/deliverable.md" });
      expect(await fs.readFile(path.join(workspace, "outputs", "deliverable.md"), "utf8")).toBe(
        "persist-me\n",
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("script relative write then demo file capture succeeds end-to-end", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-demo-"));
    try {
      const spec = {
        metadata: { name: "script-demo" },
        state: {
          channels: {
            out: { type: "object" },
            outputs: { type: "object", reducer: "mergeDeep", default: {} },
          },
        },
        nodes: [
          {
            id: "save",
            type: "script",
            with: {
              code: `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export default async function() {
  const path = "outputs/weekly-content.md";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# Weekly\\n", "utf8");
  return { path };
}
`,
              permissions: { fsWrite: ["outputs"], fsRead: ["outputs"] },
            },
          },
          {
            id: "capture",
            type: "demo",
            with: {
              label: "Weekly content deliverable",
              file: { path: "outputs/weekly-content.md" },
            },
          },
        ],
        edges: [
          { from: "START", to: "save" },
          { from: "save", to: "capture" },
          { from: "capture", to: "END" },
        ],
        runtime: { checkpoint: { enabled: false } },
      } as unknown as GraphSpec;

      const compiled = await compileGraph(spec, { cwd: workspace });
      const r = await compiled.run({
        input: {},
        threadId: "script-demo-thread",
      });
      expect(r.status).toBe("completed");
      const capture = (r.state["outputs"] as Record<string, { ok?: boolean; path?: string }>)?.[
        "capture"
      ];
      expect(capture?.ok).toBe(true);
      expect(capture?.path).toBeTruthy();
      expect(await fs.readFile(path.join(workspace, "outputs", "weekly-content.md"), "utf8")).toBe(
        "# Weekly\n",
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("stops a grandchild that traps SIGTERM", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-group-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const grandchild = `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const code = `
      export default async function () {
        process.on("SIGTERM", () => {});
        const { spawn } = await import("node:child_process");
        spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore", env: process.env });
        await new Promise(() => {});
      }
    `;
    const ac = new AbortController();
    let pid = 0;
    const pending = runScriptSandboxed(code, {
      signal: ac.signal,
      stopGraceMs: 50,
      permissions: { childProcess: true, fsWrite: [dir] },
      env: { PID_FILE: pidFile },
      workspace: dir,
    });
    try {
      pid = await grandchildPid(pidFile, dir);
      ac.abort(new Error("stop"));
      await expect(pending).rejects.toThrow(/stop/);
      await expectStopped(pid);
    } finally {
      ac.abort(new Error("stop"));
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("stops a grandchild that ignores SIGTERM after the direct child exits", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-script-group-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const code = `
      export default async function () {
        const { spawn } = await import("node:child_process");
        spawn("sh", ["-c", "trap '' TERM; echo $$ > \\"$PID_FILE\\"; sleep 30"], {
          stdio: "ignore",
          env: process.env,
        });
        await new Promise(() => {});
      }
    `;
    const ac = new AbortController();
    let pid = 0;
    const pending = runScriptSandboxed(code, {
      signal: ac.signal,
      stopGraceMs: 50,
      permissions: { childProcess: true, fsWrite: [dir] },
      env: { PID_FILE: pidFile },
      workspace: dir,
    });
    try {
      pid = await grandchildPid(pidFile, dir);
      ac.abort(new Error("stop"));
      await expect(pending).rejects.toThrow(/stop/);
      await expectStopped(pid);
    } finally {
      ac.abort(new Error("stop"));
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/** `kill(pid, 0)` still succeeds while the kernel has not reaped the process. */
async function expectStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

function grandchildPid(pidFile: string, dir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("grandchild did not start"));
    }, 4000);
    const finish = () => {
      if (!existsSync(pidFile)) return;
      const raw = readFileSync(pidFile, "utf8").trim();
      if (!/^[1-9]\d*$/.test(raw)) return;
      clearTimeout(timer);
      watcher.close();
      resolve(Number(raw));
    };
    const watcher = watch(dir, finish);
    finish();
  });
}
