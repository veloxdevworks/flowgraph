import { afterEach, expect, it, vi } from "vitest";
import { GraphSpecSchema } from "@flowgraph/spec";
import { AIMessage } from "@langchain/core/messages";
import { compileGraph } from "./compiler.js";
import { createScriptedProvider } from "./providers/index.js";
import { createLangChainProvider, type ChatModelLike } from "./providers/langchain/provider.js";
import { UsageLedger } from "./usage/ledger.js";
import type { NodeRunContext } from "./context.js";
const graph = (nodes: unknown[], runtime = {}, edges?: unknown[]) =>
  GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "paid-round2" },
    nodes,
    edges: edges ?? [
      { from: "START", to: (nodes[0] as { id: string }).id },
      ...nodes.map((n, i) => ({
        from: (n as { id: string }).id,
        to: i + 1 < nodes.length ? (nodes[i + 1] as { id: string }).id : "END",
      })),
    ],
    runtime,
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("PLAT-358: model router calls count usage and enforce hard budgets", async () => {
  const run = vi.fn(() => ({
    output: { route: "done" },
    usage: { totalTokens: 500, costUSD: 0.01 },
    stopReason: "done" as const,
  }));
  const provider = createScriptedProvider("route-paid", run);
  const spec = graph(
    [
      {
        id: "route",
        type: "router",
        with: { mode: "model", provider: "route-paid", routes: { done: { to: "END" } } },
      },
    ],
    { budget: { maxTokens: 100, onExceed: "fail" } },
  );
  const result = await (await compileGraph(spec, { providers: [provider] })).run();
  expect(result.status).toBe("error");
  expect(result.usage).toMatchObject({ calls: 1, totalTokens: 500, costUSD: 0.01 });
  expect(run).toHaveBeenCalledTimes(1);
});
it("PLAT-362: ordinary schemas opt out of vendor strict-schema restrictions and remain post-validated", async () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, optional: { type: "number" } },
    required: ["name"],
  };
  const withStructuredOutput = vi.fn(
    (_schema: unknown, config: { strict?: boolean } | undefined) => {
      if (config?.strict !== false)
        throw Object.assign(new Error("additionalProperties must be false"), { status: 400 });
      return {
        invoke: async () => ({
          parsed: { name: "ok" },
          raw: new AIMessage({
            content: "ok",
            usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
          } as ConstructorParameters<typeof AIMessage>[0]),
        }),
      };
    },
  );
  const model = { invoke: vi.fn(), withStructuredOutput } as ChatModelLike;
  const result = await (
    await compileGraph(
      graph([
        { id: "a", type: "agent", provider: "ordinary-schema", with: { prompt: "answer", schema } },
      ]),
      { providers: [createLangChainProvider(model, { name: "ordinary-schema" })] },
    )
  ).run();
  expect(result.status).toBe("completed");
  expect(withStructuredOutput).toHaveBeenCalledWith(
    schema,
    expect.objectContaining({ strict: false }),
  );
  expect(result.usage?.totalTokens).toBe(4);
});
it.each([400, 404, 405, 413, 415, 422])(
  "PLAT-362: a single rejected model request with HTTP %i leaves known zero usage",
  async (status) => {
    const model: ChatModelLike = {
      invoke: async () => {
        throw Object.assign(new Error("request refused"), { status });
      },
    };
    const result = await (
      await compileGraph(
        graph([{ id: "a", type: "agent", provider: "rejected-model", with: { prompt: "answer" } }]),
        { providers: [createLangChainProvider(model, { name: "rejected-model" })] },
      )
    ).run();
    expect(result.status).toBe("error");
    expect(result.usage).toMatchObject({
      calls: 1,
      totalTokens: 0,
      costUSD: 0,
      pendingCalls: 0,
      unknownCalls: 0,
      unreportedTokenCalls: 0,
    });
  },
);
const ctx = (id: string, signal?: AbortSignal) =>
  ({
    nodeId: id,
    signal,
    emit() {},
    logger: { warn() {} },
    interrupt() {
      throw new Error("unexpected interrupt");
    },
  }) as unknown as NodeRunContext;
it("PLAT-359: cancellation while persisting a receipt never starts a paid request or leaves pending usage", async () => {
  let record: unknown, release!: () => void, entered!: () => void;
  const written = new Promise<void>((r) => (entered = r));
  const hold = new Promise<void>((r) => (release = r));
  const saver = {
    readThreadUsage: () => record,
    async writeThreadUsage(_thread: string, next: unknown) {
      record = structuredClone(next);
      if (Object.keys((next as { pending: object }).pending).length) {
        entered();
        await hold;
      }
    },
  };
  const ledger = await UsageLedger.open(saver, "cancel");
  const abort = new AbortController();
  const invoke = vi.fn(async () => 1);
  const call = ledger.call(ctx("queued", abort.signal), invoke, {
    usage: () => ({ totalTokens: 1, costUSD: 0.1 }),
  });
  await written;
  abort.abort();
  release();
  await expect(call).rejects.toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
  expect(ledger.snapshot()).toMatchObject({ calls: 0, pendingCalls: 0, unknownCalls: 0 });
});
it("PLAT-376: known media estimates share budget headroom concurrently", async () => {
  const ledger = await UsageLedger.open({}, "parallel", { maxUSD: 0.3, onExceed: "fail" });
  let active = 0,
    peak = 0;
  const invoke = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return 1;
  };
  await Promise.all(
    [1, 2, 3].map((n) =>
      ledger.call(ctx(String(n)), invoke, {
        kind: "media",
        estimateUSD: 0.1,
        usage: () => ({ costUSD: 0.1 }),
      }),
    ),
  );
  expect(peak).toBe(3);
  expect(ledger.snapshot()).toMatchObject({ calls: 3, costUSD: 0.3, pendingCalls: 0 });
});

it("PLAT-364: times out a single model request while leaving long agent sessions configurable", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const provider = createLangChainProvider({ invoke: async () => {
    entered();
    return new Promise<AIMessage>(() => {});
  } }, { name: "hang-default" });
  // Keep checkpointing enabled, but omit the unused legacy store: LangGraph's
  // store batching loop otherwise schedules a timer for every fake millisecond.
  const compiled = await compileGraph(
    graph([{ id: "a", type: "agent", provider: "hang-default", with: { prompt: "answer" } }]),
    { providers: [provider], store: "none" },
  );
  vi.useFakeTimers();
  const running = compiled.run();
  let settled = false;
  void running.then(() => { settled = true; });
  await ready;
  await vi.advanceTimersByTimeAsync(119999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  const result = await running;
  expect(result).toMatchObject({ status: "error", error: { code: "MODEL_REQUEST_TIMEOUT" }, usage: { unknownCalls: 1 } });
});
it("PLAT-364: a long coding-provider session does not inherit a model-request timeout", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const provider = createScriptedProvider("long-session", async () => {
    entered();
    await new Promise((resolve) => setTimeout(resolve, 150000));
    return { output: "done", stopReason: "done" };
  });
  const compiled = await compileGraph(
    graph([{ id: "a", type: "agent", provider: "long-session", with: { prompt: "answer" } }]),
    { providers: [provider], store: "none" },
  );
  vi.useFakeTimers();
  const running = compiled.run();
  let settled = false;
  void running.then(() => { settled = true; });
  await ready;
  await vi.advanceTimersByTimeAsync(120001);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(30000);
  expect((await running).status).toBe("completed");
});
it("PLAT-364: outstanding model calls emit a heartbeat and stop emitting after completion", async () => {
  let finish!: (message: AIMessage) => void;
  const response = new Promise<AIMessage>((resolve) => {
    finish = resolve;
  });
  const model: ChatModelLike = { invoke: () => response };
  const provider = createLangChainProvider(model, { name: "heartbeat" });
  const emit = vi.fn();
  const context = {
    node: { ...ctx("heartbeat"), emit },
    emit() {},
    invokeTool: async () => {},
    checkToolCall: async (_name: string, args: unknown) => args,
    reportToolResult: async (_name: string, _args: unknown, result: unknown) => result,
  } as import("./providers/types.js").ProviderRunContext;
  vi.useFakeTimers();
  const running = provider.run({ prompt: "answer", tools: [], permission: "auto" }, context);
  await vi.advanceTimersByTimeAsync(15000);
  expect(emit).toHaveBeenCalledWith(
    "custom.agent.waiting",
    expect.objectContaining({ phase: "model" }),
  );
  finish(new AIMessage({ content: "done" }));
  await running;
  const calls = emit.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(emit).toHaveBeenCalledTimes(calls);
});
it("PLAT-376: concurrent reservations cannot exceed the available headroom", async () => {
  const ledger = await UsageLedger.open({}, "headroom", { maxUSD: 0.2, onExceed: "fail" });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const invoke = vi.fn(async () => {
    await held;
    return 1;
  });
  const calls = [1, 2, 3].map((n) =>
    ledger.call(ctx(String(n)), invoke, {
      kind: "media",
      estimateUSD: 0.1,
      usage: () => ({ costUSD: 0.1 }),
    }),
  );
  const settled = Promise.allSettled(calls);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  release();
  const results = await settled;
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  expect(ledger.snapshot()).toMatchObject({ costUSD: 0.2, pendingCalls: 0 });
});
it("PLAT-359: an ordinary fan-out rejection leaves no never-started sibling receipts", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "fg-paid-siblings-"));
  const seen: string[] = [];
  let reject = true;
  const nodes = ["a", "b", "c"].map((id) => ({
    id,
    type: "image",
    provider: "siblings",
    with: { prompt: id },
  }));
  const spec = graph(nodes, { budget: { maxTokens: 100, onExceed: "fail" } }, [
    { from: "START", to: ["a", "b", "c"] },
    ...nodes.map((n) => ({ from: n.id, to: "END" })),
  ]);
  const provider: import("./media/types.js").MediaProvider = {
    name: "siblings",
    vendor: "test",
    modalities: ["image"],
    async start(req) {
      seen.push(req.prompt!);
      if (reject && req.prompt === "a")
        throw Object.assign(new Error("invalid request"), { mediaSubmissionRejected: true });
      return { id: req.prompt!, done: [], costUSD: 0 };
    },
  };
  try {
    const { MemorySaver } = await import("@langchain/langgraph");
    const saver = new MemorySaver();
    const compiled = await compileGraph(spec, {
      cwd,
      checkpointer: saver,
      mediaProviders: [provider],
    });
    const first = await compiled.run({ threadId: "siblings" });
    expect(first.status).toBe("error");
    expect(first.usage?.unknownCalls).toBe(0);
    const { inspectThreadUsage } = await import("./usage/ledger.js");
    await vi.waitFor(async () =>
      expect(Object.keys((await inspectThreadUsage(saver, "siblings")).pending)).toHaveLength(0),
    );
    reject = false;
    const next = await compiled.resume({ threadId: "siblings", resume: true });
    expect(next.status).toBe("completed");
    expect(next.usage?.pendingCalls).toBe(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("PLAT-376: an unestimated call cannot use fully reserved dollar headroom",async()=>{
  const ledger=await UsageLedger.open({},"full-reservation",{maxUSD:0.2,onExceed:"fail"});
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  const invoke=vi.fn(async()=>{await held;return 1;});
  const calls=[1,2].map(n=>ledger.call(ctx(String(n)),invoke,{kind:"media",estimateUSD:0.1,usage:()=>({costUSD:0.1})}));
  await vi.waitFor(()=>expect(invoke).toHaveBeenCalledTimes(2));
  const unestimated=vi.fn(async()=>1);
  try {await expect(ledger.call(ctx("unknown"),unestimated,{kind:"media",usage:()=>({costUSD:0.05})})).rejects.toMatchObject({code:"BUDGET_EXCEEDED"});expect(unestimated).not.toHaveBeenCalled();}
  finally{release();await Promise.all(calls);}
});
