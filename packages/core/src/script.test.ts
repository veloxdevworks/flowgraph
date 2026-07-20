import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph } from "./compiler.js";
import { ScriptWithSchema, type GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { runScriptSandboxed } from "./nodes/script.js";

function scriptSpec(nodeWith: Record<string, unknown>): GraphSpec {
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

  it("accepts permissions and timeout", () => {
    const r = ScriptWithSchema.safeParse({
      code: "export default async () => ({})",
      timeout: "5s",
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
        { timeoutMs: 200 },
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
        timeout: "200ms",
        output: { to: "out" },
      }),
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
});
