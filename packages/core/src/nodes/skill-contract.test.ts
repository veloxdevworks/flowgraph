import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { createScriptedProvider } from "../providers/index.js";

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

  // 3. Executable skill with timeout that waits on ctx.signal.
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
});

afterAll(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("skill data contract & runtime enforcement", () => {
  it("DATA-6: command skills receive rendered input on both stdin and FLOWGRAPH_INPUT", async () => {
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

  it("DATA-6: skill-as-tool builds tool spec from skill description and inputs and executes the skill", async () => {
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

  it("CUT-4: enforces declared skill outputs schema and fails with SKILL_OUTPUT_INVALID", async () => {
    const makeSpec = (input: Record<string, unknown>) =>
      ({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "output-check" },
        state: { channels: { out: { type: "object" } } },
        nodes: [
          {
            id: "s",
            type: "skill",
            uses: "./skills/checked-output",
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

    const ok = await (await compileGraph(makeSpec({}), { cwd: fixtureDir })).run();
    expect(ok.status).toBe("completed");
    expect(ok.state["out"]).toEqual({ count: 42 });

    const wrongType = await (await compileGraph(makeSpec({ badType: true }), { cwd: fixtureDir })).run();
    expect(wrongType.status).toBe("error");
    expect((wrongType.error as Error & { code?: string })?.code).toBe("SKILL_OUTPUT_INVALID");
    expect(wrongType.error?.message).toContain("count");

    const missing = await (await compileGraph(makeSpec({ missingKey: true }), { cwd: fixtureDir })).run();
    expect(missing.status).toBe("error");
    expect((missing.error as Error & { code?: string })?.code).toBe("SKILL_OUTPUT_INVALID");
    expect(missing.error?.message).toContain("missing");
  });

  it("CUT-4: enforces front-matter timeout and fails with SKILL_TIMEOUT", async () => {
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
});
