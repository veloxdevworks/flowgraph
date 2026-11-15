import { expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { compileGraph } from "./compiler.js";
import { GraphSpecSchema } from "@flowgraph/spec";
import { createLangChainProvider, type ChatModelLike } from "./providers/langchain/provider.js";
import { createScriptedProvider, registerTool } from "./providers/index.js";
it("keeps completed model and tool steps across an errored invocation and recompilation", async () => {
  const effect = vi.fn(() => "saved");
  registerTool({ name: "crash_effect", handler: effect });
  let calls = 0,
    fail = true;
  const model: ChatModelLike = {
    async invoke(input) {
      calls++;
      const initial = input.length === 1;
      if (!initial && fail) {
        fail = false;
        throw new Error("crash after finished tool");
      }
      return new AIMessage({
        content: initial ? "" : "done",
        ...(initial ? { tool_calls: [{ id: "call", name: "crash_effect", args: {} }] } : {}),
        usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      } as ConstructorParameters<typeof AIMessage>[0]);
    },
    bindTools() {
      return this;
    },
  };
  const spec = GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "crash" },
    nodes: [
      {
        id: "a",
        type: "agent",
        provider: "test",
        with: { prompt: "test", tools: [{ function: "crash_effect" }] },
      },
    ],
    edges: [
      { from: "START", to: "a" },
      { from: "a", to: "END" },
    ],
  });
  const saver = new MemorySaver(),
    provider = createLangChainProvider(model, { name: "test" });
  expect(
    (
      await (
        await compileGraph(spec, { providers: [provider], checkpointer: saver })
      ).run({ threadId: "crash" })
    ).status,
  ).toBe("error");
  expect(
    (
      await (
        await compileGraph(spec, { providers: [provider], checkpointer: saver })
      ).resume({ threadId: "crash", resume: true })
    ).status,
  ).toBe("completed");
  expect(effect).toHaveBeenCalledTimes(1);
  expect(calls).toBe(3);
});

it("historical side effects require a separate workspace and preserve the source output", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "fg-history-"));
  try {
    const s = GraphSpecSchema.parse({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "history" },
      nodes: [
        { id: "seed", type: "shell", with: { command: "true" } },
        {
          id: "write",
          type: "shell",
          with: {
            command: process.execPath,
            args: ["-e", "require('fs').writeFileSync('output.txt',String(Date.now()))"],
          },
        },
      ],
      edges: [
        { from: "START", to: "seed" },
        { from: "seed", to: "write" },
        { from: "write", to: "END" },
      ],
    });
    const g = await compileGraph(s, { cwd: dir });
    expect((await g.run({ threadId: "history" })).status).toBe("completed");
    const before = await readFile(join(dir, "output.txt"), "utf8");
    const old = (await g.getStateHistory("history")).find((x) =>
      x.next.includes("seed"),
    )!.checkpointId!;
    await expect(
      g.resumeFrom({ threadId: "history", checkpointId: old, resume: true }),
    ).rejects.toMatchObject({ code: "HISTORICAL_REPLAY_WORKSPACE_REQUIRED" });
    expect(
      (
        await g.resumeFrom({
          threadId: "history",
          checkpointId: old,
          resume: true,
          replayWorkspace: join(dir, "fork"),
        })
      ).status,
    ).toBe("completed");
    expect(await readFile(join(dir, "output.txt"), "utf8")).toBe(before);
    expect(await readFile(join(dir, "fork/output.txt"), "utf8")).not.toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("normal cancellation stops shell work and remains resumable without crash reconciliation", async () => {
  const { mkdtemp, access, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "fg-shell-abort-"));
  try {
    const code =
      "const fs=require('fs');if(!fs.existsSync('ready')){fs.writeFileSync('ready','yes');setTimeout(()=>{},30000);}else process.stdout.write('resumed');";
    const g = await compileGraph(
      GraphSpecSchema.parse({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "abort" },
        nodes: [
          { id: "s", type: "shell", with: { command: process.execPath, args: ["-e", code] } },
        ],
        edges: [
          { from: "START", to: "s" },
          { from: "s", to: "END" },
        ],
      }),
      { cwd: dir },
    );
    const signal = new AbortController(),
      running = g.run({ threadId: "abort", signal: signal.signal });
    await vi.waitFor(
      async () => {
        await access(join(dir, "ready"));
      },
      { timeout: 5000 },
    );
    signal.abort();
    expect((await running).status).toBe("aborted");
    expect((await g.resume({ threadId: "abort", resume: true })).status).toBe("completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves model content blocks when replaying a saved response", async () => {
  const { serializeReplayValue, deserializeReplayValue } =
    await import("./providers/replay-cache.js");
  const content = [{ type: "text" as const, text: "completed answer" }];
  const restored = deserializeReplayValue(serializeReplayValue(new AIMessage({ content })));
  expect((restored as AIMessage).content).toEqual(content);
});

it.each(["abort", "timeout"])("retries a settled agent tool after controlled %s", async (mode) => {
  const tool = `controlled_${mode}`;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const effect = vi.fn();
  registerTool({
    name: tool,
    async handler(_args, ctx) {
      if (calls++ === 0) {
        started();
        await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(ctx.signal!.reason);
          ctx.signal!.addEventListener("abort", stop, { once: true });
          if (ctx.signal!.aborted) stop();
        });
      }
      effect();
      return "done";
    },
  });
  const provider = createScriptedProvider(tool, async (_req, ctx) => ({
    output: await ctx.invokeTool(tool, {}),
    stopReason: "done",
  }));
  const graph = await compileGraph(
    GraphSpecSchema.parse({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: `controlled-${mode}` },
      nodes: [
        {
          id: "a",
          type: "agent",
          provider: tool,
          ...(mode === "timeout"
            ? { timeout: "1s", retry: { maxAttempts: 2, baseMs: 10, jitter: false } }
            : {}),
          with: { prompt: "test", tools: [{ function: tool }] },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    }),
    { providers: [provider], checkpointer: new MemorySaver() },
  );
  const controller = new AbortController();
  const running = graph.run({ threadId: tool, signal: controller.signal });
  await ready;
  if (mode === "abort") {
    controller.abort();
    expect((await running).status).toBe("aborted");
    expect((await graph.resume({ threadId: tool, resume: true })).status).toBe("completed");
  } else {
    const result = await running;
    expect(result.status, JSON.stringify(result.error)).toBe("completed");
  }
  expect(calls).toBe(2);
  expect(effect).toHaveBeenCalledTimes(1);
});

it("keeps the uncertainty guard when an agent tool ignores cancellation", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const result = new Promise<string>((resolve) => {
    finish = () => resolve("done");
  });
  let completed!: () => void;
  const settled = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const handler = vi.fn(() => {
    started();
    return result;
  });
  registerTool({ name: "ignores_cancel", handler });
  const provider = createScriptedProvider("ignores-cancel", async (_req, ctx) => {
    const output = await ctx.invokeTool("ignores_cancel", {});
    completed();
    return { output, stopReason: "done" };
  });
  const graph = await compileGraph(
    GraphSpecSchema.parse({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "ignores-cancel" },
      nodes: [
        {
          id: "a",
          type: "agent",
          provider: "ignores-cancel",
          with: {
            prompt: "test",
            tools: [{ function: "ignores_cancel" }],
          },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    }),
    { providers: [provider], checkpointer: new MemorySaver() },
  );
  try {
    const controller = new AbortController();
    const running = graph.run({ threadId: "ignores-cancel", signal: controller.signal });
    await ready;
    controller.abort();
    expect((await running).status).toBe("aborted");
    const resumed = await graph.resume({ threadId: "ignores-cancel", resume: true });
    expect(resumed.status).toBe("error");
    expect(resumed.error).toMatchObject({ code: "TOOL_OUTCOME_UNCERTAIN" });
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    await settled;
  }
});

it("seeds legacy interrupt replay atomically before an upgraded resume can crash again", async () => {
  const { createScriptedProvider } = await import("./providers/index.js");
  const saver = new MemorySaver();
  let calls = 0,
    fail = true;
  const effect = vi.fn(() => "done");
  registerTool({ name: "legacy_upgrade_effect", handler: effect });
  const provider = createScriptedProvider("upgrade", async (_req, ctx) => {
    if (ctx.replay?.get("llm:0") === undefined) {
      calls++;
      await ctx.replay?.set("llm:0", { answer: "cached" });
    }
    await ctx.invokeTool("legacy_upgrade_effect", {});
    ctx.node.interrupt({ reason: "approve", kind: "approval" });
    if (fail) {
      fail = false;
      throw new Error("crash during first upgraded continuation");
    }
    return { output: "done", stopReason: "done" };
  });
  const spec = GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "upgrade" },
    nodes: [
      {
        id: "a",
        type: "agent",
        provider: "upgrade",
        with: { prompt: "test", tools: [{ function: "legacy_upgrade_effect" }] },
      },
    ],
    edges: [
      { from: "START", to: "a" },
      { from: "a", to: "END" },
    ],
  });
  const compile = () => compileGraph(spec, { checkpointer: saver, providers: [provider] });
  expect((await (await compile()).run({ threadId: "upgrade" })).status).toBe("interrupted");
  // Simulate upgrading from a saver/process with only private interrupt snapshots
  // to a durable replay adapter whose table has no records for this old task.
  const records = new Map<string, Record<string, unknown>>();
  Object.assign(saver, {
    readThreadReplay: (_thread: string, task: string) => records.get(task),
    initializeThreadReplay: (_thread: string, task: string, entries: Record<string, unknown>) => {
      if (!records.has(task)) records.set(task, JSON.parse(JSON.stringify(entries)));
    },
    compareThreadReplay: (
      _thread: string,
      task: string,
      index: string,
      expected: unknown,
      value: unknown,
    ) => {
      const entries = { ...records.get(task) };
      if (JSON.stringify(entries[index]) !== JSON.stringify(expected)) return false;
      if (value === undefined) delete entries[index];
      else entries[index] = value;
      records.set(task, JSON.parse(JSON.stringify(entries)));
      return true;
    },
    listThreadReplay: () => [...records].map(([task, entries]) => ({ task, entries })),
  });
  expect((await (await compile()).resume({ threadId: "upgrade", resume: true })).status).toBe(
    "error",
  );
  expect((await (await compile()).resume({ threadId: "upgrade", resume: true })).status).toBe(
    "completed",
  );
  expect(effect).toHaveBeenCalledTimes(1);
  expect(calls).toBe(1);
});
