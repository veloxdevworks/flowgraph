import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph } from "./compiler.js";
import { ShellWithSchema } from "@veloxdevworks/flowgraph-spec";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { normalizeShellText } from "./nodes/shell.js";

function shellSpec(nodeWith: Record<string, unknown>): GraphSpec {
  return {
    metadata: { name: "shell-test" },
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
        type: "shell",
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

describe("ShellWithSchema", () => {
  it("requires command", () => {
    expect(ShellWithSchema.safeParse({}).success).toBe(false);
    expect(ShellWithSchema.safeParse({ command: "echo" }).success).toBe(true);
    expect(
      ShellWithSchema.safeParse({ command: "echo", args: ["hi"], timeout: "5s" }).success,
    ).toBe(true);
  });
});

describe("normalizeShellText", () => {
  it("converts curly quotes to ASCII", () => {
    expect(normalizeShellText("echo \u201C$HELLO world!\u201D")).toBe('echo "$HELLO world!"');
    expect(normalizeShellText("echo \u2018hi\u2019")).toBe("echo 'hi'");
  });
});

describe("shell node", () => {
  it("runs argv mode (no shell) and maps output", async () => {
    const compiled = await compileGraph(
      shellSpec({
        command: "echo",
        args: ["hello-shell"],
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const out = r.state["out"] as { stdout: string; exitCode: number };
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("hello-shell");
  });

  it("runs shell-string mode with &&", async () => {
    const compiled = await compileGraph(
      shellSpec({
        command: "echo one && echo two",
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const out = r.state["out"] as { stdout: string; exitCode: number };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("one");
    expect(out.stdout).toContain("two");
  });

  it("normalizes curly quotes and expands env in shell-string mode", async () => {
    const compiled = await compileGraph(
      shellSpec({
        // Curly open + curly close — same failure mode as macOS smart quotes.
        command: "echo \u201C$HELLO world!\u201D",
        env: { HELLO: "Hello" },
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const out = r.state["out"] as { stdout: string; exitCode: number };
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("Hello world!");
  });

  it("throws on nonzero exit unless allowed", async () => {
    const compiled = await compileGraph(
      shellSpec({
        command: "false",
        args: [],
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
  });

  it("allows nonzero exit via expect.exitCode", async () => {
    const compiled = await compileGraph(
      shellSpec({
        command: "false",
        args: [],
        expect: { exitCode: [1] },
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const out = r.state["out"] as { exitCode: number };
    expect(out.exitCode).toBe(1);
  });

  it("honors cwd and env", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fg-shell-cwd-"));
    try {
      const compiled = await compileGraph(
        shellSpec({
          command: "node",
          args: ["-e", "process.stdout.write(process.cwd() + '|' + process.env.FG_MARK)"],
          cwd: tmp,
          env: { FG_MARK: "marked" },
          output: { to: "out" },
        }),
        {},
      );
      const r = await compiled.run({ input: {} });
      expect(r.status).toBe("completed");
      const out = r.state["out"] as { stdout: string };
      expect(out.stdout).toContain(tmp);
      expect(out.stdout).toContain("marked");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("passes input via FLOWGRAPH_INPUT and stdin", async () => {
    const compiled = await compileGraph(
      shellSpec({
        command: "node",
        args: [
          "-e",
          "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write(process.env.FLOWGRAPH_INPUT===s?'ok':'mismatch')})",
        ],
        input: { n: 42 },
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const out = r.state["out"] as { stdout: string };
    expect(out.stdout.trim()).toBe("ok");
  });

  it("parses JSON stdout into result.json", async () => {
    const compiled = await compileGraph(
      shellSpec({
        command: "node",
        args: ["-e", "process.stdout.write(JSON.stringify({a:1}))"],
        output: { map: { text: "{{ result.json.a }}" } },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state["text"]).toBe(1);
  });

  it("times out long-running commands", async () => {
    const compiled = await compileGraph(
      shellSpec({
        command: "node",
        args: ["-e", "setTimeout(()=>{}, 60000)"],
        timeout: "200ms",
        output: { to: "out" },
      }),
      {},
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
  }, 10_000);

  it("renders templates in args from state", async () => {
    const compiled = await compileGraph(
      shellSpec({
        command: "echo",
        args: ["Hello, {{ state.name }}!"],
        output: { map: { text: "{{ result.stdout }}" } },
      }),
      {},
    );
    const r = await compiled.run({ input: { name: "Ada" } });
    expect(r.status).toBe("completed");
    expect(String(r.state["text"]).trim()).toBe("Hello, Ada!");
  });

  it("auto-declares undeclared output channels so HITL can read shell stdout", async () => {
    // Reproduces the desktop bug: output.to: shell with empty state.channels —
    // LangGraph would silently drop the write unless compileGraph auto-declares.
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "shell-hitl" },
      state: { channels: {} },
      nodes: [
        {
          id: "shell-1",
          type: "shell",
          with: {
            command: 'echo "Hello world!"',
            output: { to: "shell" },
          },
        },
        {
          id: "hitl-1",
          type: "hitl",
          with: {
            mode: "approve",
            message: 'Shell ran, and received response:\n"{{ state.shell.stdout }}"',
          },
        },
      ],
      edges: [
        { from: "START", to: "shell-1" },
        { from: "shell-1", to: "hitl-1" },
        { from: "hitl-1", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ threadId: `shell-hitl-${Date.now()}`, onInterrupt: "fail" });
    expect(r.status).toBe("interrupted");
    expect(r.interrupts?.[0]?.reason).toContain("Hello world!");
    expect(r.state["shell"]).toMatchObject({ stdout: expect.stringContaining("Hello world!") });
  });
});

