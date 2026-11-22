import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { loadSkill } from "@flowgraph/skills";
import { compileGraph } from "../compiler.js";
import { createScriptedProvider } from "../providers/index.js";
import type { NodeRunContext } from "../context.js";
import { runSkill } from "./skill-runner.js";

let fixtureDir = "";

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-skill-contract-"));

  // 1. Command skill that reads stdin AND FLOWGRAPH_INPUT and echoes both back.
  const stdinSkillDir = path.join(fixtureDir, "skills", "stdin-echo");
  await fs.mkdir(stdinSkillDir, { recursive: true });
  const stdinScript = [
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => (buf += c));",
    "process.stdin.on('end', () => {",
    "  const fromStdin = buf ? JSON.parse(buf) : null;",
    "  const fromEnv = process.env.FLOWGRAPH_INPUT ? JSON.parse(process.env.FLOWGRAPH_INPUT) : null;",
    "  process.stdout.write(JSON.stringify({ fromStdin, fromEnv }));",
    "});",
  ].join(" ");
  await fs.writeFile(
    path.join(stdinSkillDir, "SKILL.md"),
    `---
apiVersion: flowgraph/v1
kind: Skill
name: stdin-echo
version: 0.1.0
description: Echoes structured input from stdin and FLOWGRAPH_INPUT
kindOf: command
command: ${JSON.stringify([process.execPath, "-e", stdinScript])}
inputs:
  query:
    type: string
    required: true
    description: Search query string
  limit:
    type: number
    description: Max items
outputs:
  fromStdin:
    type: object
  fromEnv:
    type: object
---
`,
  );

  // 2. Executable skill that returns a configurable payload (to test outputs validation).
  const outSkillDir = path.join(fixtureDir, "skills", "checked-output");
  await fs.mkdir(outSkillDir, { recursive: true });
  await fs.writeFile(
    path.join(outSkillDir, "handler.mjs"),
    `export default async function (input) {
  if (input.badType) return { count: "not-a-number" };
  if (input.missingKey) return {};
  return { count: 42 };
}
`,
  );
  await fs.writeFile(
    path.join(outSkillDir, "SKILL.md"),
    `---
apiVersion: flowgraph/v1
kind: Skill
name: checked-output
version: 0.1.0
description: Returns a checked count
kindOf: executable
handler: ./handler.mjs
inputs:
  badType:
    type: boolean
  missingKey:
    type: boolean
outputs:
  count:
    type: number
---
`,
  );

  // 3. Executable skill with an output key that exists on Object.prototype.
  const protoSkillDir = path.join(fixtureDir, "skills", "proto-output");
  await fs.mkdir(protoSkillDir, { recursive: true });
  await fs.writeFile(
    path.join(protoSkillDir, "handler.mjs"),
    `export default async function () {
  return {};
}
`,
  );
  await fs.writeFile(
    path.join(protoSkillDir, "SKILL.md"),
    `---
apiVersion: flowgraph/v1
kind: Skill
name: proto-output
version: 0.1.0
kindOf: executable
handler: ./handler.mjs
outputs:
  toString:
    type: string
---
`,
  );

  // 4. Executable skill with timeout that waits on ctx.signal.
  const slowSkillDir = path.join(fixtureDir, "skills", "abort-aware");
  await fs.mkdir(slowSkillDir, { recursive: true });
  await fs.writeFile(
    path.join(slowSkillDir, "handler.mjs"),
    `export default async function (_input, ctx) {
  return await new Promise((_resolve, reject) => {
    if (ctx.signal?.aborted) {
      reject(ctx.signal.reason ?? new Error("aborted"));
      return;
    }
    ctx.signal?.addEventListener("abort", () => {
      reject(ctx.signal.reason ?? new Error("aborted"));
    });
    ctx.emit("custom.skill.waiting", {});
  });
}
`,
  );
  await fs.writeFile(
    path.join(slowSkillDir, "SKILL.md"),
    `---
apiVersion: flowgraph/v1
kind: Skill
name: abort-aware
version: 0.1.0
kindOf: executable
handler: ./handler.mjs
timeout: 250ms
---
`,
  );

  // 5. Command skill that ignores SIGTERM and notifies a local socket once ready.
  const stubbornDir = path.join(fixtureDir, "skills", "stubborn-cmd");
  await fs.mkdir(stubbornDir, { recursive: true });
  const stubbornScript = [
    "const net = require('node:net');",
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => {});",
    "const grand = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 60000);'], { stdio: 'ignore' });",
    "const input = JSON.parse(process.env.FLOWGRAPH_INPUT || '{}');",
    "const sock = net.connect(input.port, '127.0.0.1', () => {",
    "  sock.end(JSON.stringify({ pid: process.pid, grandPid: grand.pid }));",
    "});",
    "setInterval(() => {}, 60000);",
  ].join(" ");
  await fs.writeFile(
    path.join(stubbornDir, "SKILL.md"),
    `---
apiVersion: flowgraph/v1
kind: Skill
name: stubborn-cmd
version: 0.1.0
kindOf: command
command: ${JSON.stringify([process.execPath, "-e", stubbornScript])}
timeout: 250ms
inputs:
  port:
    type: number
    required: true
---
`,
  );

  // 6. Command skill that writes more than a small maxBuffer to stdout or stderr.
  const noisyDir = path.join(fixtureDir, "skills", "noisy-cmd");
  await fs.mkdir(noisyDir, { recursive: true });
  const noisyScript = [
    "const input = JSON.parse(process.env.FLOWGRAPH_INPUT || '{}');",
    "const chunk = 'x'.repeat(256);",
    "if (input.stream === 'stderr') process.stderr.write(chunk);",
    "else process.stdout.write(chunk);",
  ].join(" ");
  await fs.writeFile(
    path.join(noisyDir, "SKILL.md"),
    `---
apiVersion: flowgraph/v1
kind: Skill
name: noisy-cmd
version: 0.1.0
kindOf: command
command: ${JSON.stringify([process.execPath, "-e", noisyScript])}
inputs:
  stream:
    type: string
---
`,
  );
});

afterAll(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stubCtx(): NodeRunContext {
  return {
    nodeId: "test-skill",
    workspace: fixtureDir,
    config: {},
    meta: { runId: "run-1", threadId: "thread-1", graphName: "test" },
    emit: () => undefined,
  } as unknown as NodeRunContext;
}

describe("skill data contract & runtime enforcement", () => {
  it("command skills receive rendered input on both stdin and FLOWGRAPH_INPUT", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "stdin-check" },
      state: { channels: { out: { type: "object" } } },
      nodes: [
        {
          id: "run",
          type: "skill",
          uses: "./skills/stdin-echo",
          input: { query: "hello", limit: 5 },
          with: {
            output: { to: "out" },
          },
        },
      ],
      edges: [
        { from: "START", to: "run" },
        { from: "run", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const result = await (await compileGraph(spec, { cwd: fixtureDir })).run();
    expect(result.status).toBe("completed");
    expect(result.state["out"]).toEqual({
      fromStdin: { query: "hello", limit: 5 },
      fromEnv: { query: "hello", limit: 5 },
    });
  });

  it("skill-as-tool builds tool spec from skill description and inputs and executes the skill", async () => {
    let seenTool: { name: string; description?: string; schema?: Record<string, unknown> } | undefined;
    const provider = createScriptedProvider("skill-tool-test", async (req, ctx) => {
      seenTool = req.tools?.find((t) => t.name === "stdin-echo");
      const toolResult = await ctx.invokeTool!("stdin-echo", { query: "from-agent", limit: 3 });
      return { output: toolResult, stopReason: "done" };
    });

    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "agent-skill-tool" },
      imports: [{ skill: "./skills/stdin-echo", as: "stdin-echo" }],
      state: { channels: { out: { type: "object" } } },
      nodes: [
        {
          id: "a",
          type: "agent",
          provider: "skill-tool-test",
          with: {
            prompt: "invoke stdin-echo",
            tools: [{ skill: "stdin-echo" }],
            output: { to: "out" },
          },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const result = await (await compileGraph(spec, { cwd: fixtureDir, providers: [provider] })).run();
    expect(result.status).toBe("completed");
    expect(seenTool).toBeDefined();
    expect(seenTool!.description).toBe("Echoes structured input from stdin and FLOWGRAPH_INPUT");
    expect(seenTool!.schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        limit: { type: "number", description: "Max items" },
      },
      required: ["query"],
    });
    expect(result.state["out"]).toEqual({
      fromStdin: { query: "from-agent", limit: 3 },
      fromEnv: { query: "from-agent", limit: 3 },
    });
  });

  it("enforces declared skill outputs schema and rejects inherited prototype properties", async () => {
    const makeSpec = (uses: string, input: Record<string, unknown> = {}) =>
      ({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "output-check" },
        state: { channels: { out: { type: "object" } } },
        nodes: [
          {
            id: "s",
            type: "skill",
            uses,
            input,
            with: { output: { to: "out" } },
          },
        ],
        edges: [
          { from: "START", to: "s" },
          { from: "s", to: "END" },
        ],
        runtime: { checkpoint: { enabled: false } },
      }) as unknown as GraphSpec;

    const ok = await (await compileGraph(makeSpec("./skills/checked-output"), { cwd: fixtureDir })).run();
    expect(ok.status).toBe("completed");
    expect(ok.state["out"]).toEqual({ count: 42 });

    const wrongType = await (
      await compileGraph(makeSpec("./skills/checked-output", { badType: true }), { cwd: fixtureDir })
    ).run();
    expect(wrongType.status).toBe("error");
    expect((wrongType.error as Error & { code?: string })?.code).toBe("SKILL_OUTPUT_INVALID");
    expect(wrongType.error?.message).toContain("count");

    const missing = await (
      await compileGraph(makeSpec("./skills/checked-output", { missingKey: true }), { cwd: fixtureDir })
    ).run();
    expect(missing.status).toBe("error");
    expect((missing.error as Error & { code?: string })?.code).toBe("SKILL_OUTPUT_INVALID");
    expect(missing.error?.message).toContain("missing");

    const inherited = await (
      await compileGraph(makeSpec("./skills/proto-output"), { cwd: fixtureDir })
    ).run();
    expect(inherited.status).toBe("error");
    expect((inherited.error as Error & { code?: string })?.code).toBe("SKILL_OUTPUT_INVALID");
    expect(inherited.error?.message).toContain('declared output "toString" is missing');
  });

  it("enforces front-matter timeout on executable skills and fails with SKILL_TIMEOUT", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "timeout-check" },
      state: { channels: { out: { type: "object" } } },
      nodes: [
        {
          id: "s",
          type: "skill",
          uses: "./skills/abort-aware",
          with: { output: { to: "out" } },
        },
      ],
      edges: [
        { from: "START", to: "s" },
        { from: "s", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    const compiled = await compileGraph(spec, {
      cwd: fixtureDir,
      sinks: [
        (event) => {
          if (event.type === "custom.skill.waiting") markWaiting();
        },
      ],
    });
    vi.useFakeTimers();
    const runPromise = compiled.run();
    await waiting;
    await vi.advanceTimersByTimeAsync(250);
    const result = await runPromise;
    expect(result.status).toBe("error");
    expect((result.error as Error & { code?: string })?.code).toBe("SKILL_TIMEOUT");
    expect(result.error?.message).toContain("timed out after 250ms");
  });

  it.skipIf(process.platform === "win32")(
    "SIGKILLs a timed-out command skill and its process group after the grace period",
    async () => {
      const { skill } = await loadSkill(path.join(fixtureDir, "skills", "stubborn-cmd"));
      expect(skill).not.toBeNull();

      let resolveReady!: (pids: { pid: number; grandPid: number }) => void;
      const ready = new Promise<{ pid: number; grandPid: number }>((resolve) => {
        resolveReady = resolve;
      });
      const server = net.createServer((socket) => {
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (c) => (data += c));
        socket.on("end", () => {
          resolveReady(JSON.parse(data) as { pid: number; grandPid: number });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as net.AddressInfo;

      const killSpy = vi.spyOn(process, "kill");
      let settled = false;
      try {
        vi.useFakeTimers();
        const runPromise = runSkill(skill!, { port }, stubCtx(), { stopGraceMs: 1_500 }).then(
          () => {
            settled = true;
            return undefined;
          },
          (err: unknown) => {
            settled = true;
            return err;
          },
        );

        const { pid } = await ready;
        await vi.advanceTimersByTimeAsync(250);
        expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
        expect(killSpy).not.toHaveBeenCalledWith(-pid, "SIGKILL");
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1_500);
        const err = await runPromise;
        expect(killSpy).toHaveBeenCalledWith(-pid, "SIGKILL");
        expect((err as Error & { code?: string })?.code).toBe("SKILL_TIMEOUT");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("fails with SKILL_OUTPUT_LIMIT instead of silently truncating output over maxBuffer", async () => {
    const { skill } = await loadSkill(path.join(fixtureDir, "skills", "noisy-cmd"));
    expect(skill).not.toBeNull();

    await expect(
      runSkill(skill!, { stream: "stdout" }, stubCtx(), { maxBuffer: 64 }),
    ).rejects.toMatchObject({
      code: "SKILL_OUTPUT_LIMIT",
    });

    await expect(
      runSkill(skill!, { stream: "stderr" }, stubCtx(), { maxBuffer: 64 }),
    ).rejects.toMatchObject({
      code: "SKILL_OUTPUT_LIMIT",
    });
  });
});
