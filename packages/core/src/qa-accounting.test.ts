import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { createScriptedProvider, registerTool } from "./providers/index.js";
import { createLangChainProvider, type ChatModelLike } from "./providers/langchain/provider.js";
import { validateSpec } from "./loader.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function spec(nodes: unknown[], runtime = {}): GraphSpec {
  return GraphSpecSchema.parse({ apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "accounting" }, state: { channels: { bill: { type: "object" } } }, nodes, edges: [{ from: "START", to: (nodes[0] as { id: string }).id }, ...nodes.map((n, i) => ({ from: (n as { id: string }).id, to: i + 1 < nodes.length ? (nodes[i + 1] as { id: string }).id : "END" }))], runtime });
}
const agent = (id = "a", extra = {}) => ({ id, type: "agent", provider: "usage-qa", with: { prompt: "answer", ...extra } });
function fake(responses: AIMessage[]): ChatModelLike {
  let n = 0;
  return { invoke: vi.fn(async () => responses[Math.min(n++, responses.length - 1)]!), bindTools() { return this; } };
}
const message = (tokens: number, tool = false) => new AIMessage({ content: tool ? "" : "done", usage_metadata: { input_tokens: tokens - 1, output_tokens: 1, total_tokens: tokens }, ...(tool ? { tool_calls: [{ id: "call", name: "usage_tool", args: {} }] } : {}) } as ConstructorParameters<typeof AIMessage>[0]);

describe("usage and budget regressions", () => {
  it("emits usage once and exposes totals to RunResult, run.end and graph output mappings", async () => {
    const provider = createScriptedProvider("usage-qa", (_req, ctx) => { const usage = { totalTokens: 7, costUSD: 0.002 }; ctx.emit("usage", usage); return { output: "done", usage, stopReason: "done" }; });
    const g = await compileGraph(spec([agent("a", { output: { map: { bill: "{{ run.usage }}" } } })]), { providers: [provider] });
    const events: Array<{ type: string; data: unknown }> = []; g.events.subscribe(e => { events.push(e); });
    const result = await g.run();
    expect(events.filter(e => e.type === "agent.usage")).toHaveLength(1);
    expect(result).toMatchObject({ usage: { totalTokens: 7, costUSD: 0.002 } });
    expect(result.state.bill).toMatchObject({ totalTokens: 7, costUSD: 0.002 });
    expect(events.find(e => e.type === "run.end")?.data).toMatchObject({ usage: { totalTokens: 7, costUSD: 0.002 } });
  });
  it("keeps cumulative spend across recompilation and refuses another paid retry", async () => {
    let calls = 0;
    const provider = createScriptedProvider("usage-qa", () => { calls++; return { output: "done", usage: { totalTokens: 6, costUSD: 0.002 }, stopReason: "done" }; });
    const s = spec([agent("a"), { id: "gate", type: "hitl", with: { mode: "approve", message: "yes?" } }, agent("b")], { budget: { maxUSD: 0.003, onExceed: "fail" } });
    const saver = new MemorySaver();
    expect((await (await compileGraph(s, { providers: [provider], checkpointer: saver })).run({ threadId: "budget" })).status).toBe("interrupted");
    const second = await (await compileGraph(s, { providers: [provider], checkpointer: saver })).resume({ threadId: "budget", resume: true });
    expect(second).toMatchObject({ status: "error", usage: { totalTokens: 12, costUSD: 0.004 } });
    const third = await (await compileGraph(s, { providers: [provider], checkpointer: saver })).resume({ threadId: "budget", resume: true });
    expect(third.status).toBe("error"); expect(calls).toBe(2);
  });
  it("checks token admission between LangChain tool-loop calls", async () => {
    registerTool({ name: "usage_tool", handler: () => "fact" });
    const model = fake([message(6, true), message(6)]);
    const g = await compileGraph(spec([agent("a", { tools: [{ function: "usage_tool" }], maxSteps: 3 })], { budget: { maxTokens: 5, onExceed: "fail" } }), { providers: [createLangChainProvider(model, { name: "usage-qa" })] });
    expect((await g.run()).status).toBe("error"); expect(model.invoke).toHaveBeenCalledTimes(1);
  });
  it("records a model call before a tool approval interrupts it, without charging replay twice", async () => {
    registerTool({ name: "usage_tool", handler: () => "fact" });
    const model = fake([message(6, true), message(4)]);
    const saver = new MemorySaver();
    const s = spec([agent("a", { tools: [{ function: "usage_tool" }], permission: "ask" })]);
    const provider = createLangChainProvider(model, { name: "usage-qa" });
    const first = await (await compileGraph(s, { checkpointer: saver, providers: [provider] })).run({ threadId: "pause" });
    expect(first).toMatchObject({ status: "interrupted", usage: { totalTokens: 6 } });
    const next = await (await compileGraph(s, { checkpointer: saver, providers: [provider] })).resume({ threadId: "pause", resume: true });
    expect(next).toMatchObject({ status: "completed", usage: { totalTokens: 10 } });
    expect(model.invoke).toHaveBeenCalledTimes(2);
  });
  it("warns offline that a LangChain USD cap has no model pricing", () => {
    const s = spec([{ ...agent(), provider: "langchain" }], { budget: { maxUSD: 0.0000001, onExceed: "fail" } });
    expect(validateSpec(s)).toContainEqual(expect.objectContaining({ code: "BUDGET_USD_UNPRICED", severity: "warning" }));
  });
});


it("emits actual model chunks when streaming is requested and charges the call once", async () => {
  const model: ChatModelLike = { invoke: vi.fn(async () => message(5)), async *stream() {
    yield new AIMessageChunk({ content: "hel" });
    yield new AIMessageChunk({ content: "lo", usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } as ConstructorParameters<typeof AIMessageChunk>[0]);
  } };
  const g = await compileGraph(spec([agent("a", { streaming: true })]), { providers: [createLangChainProvider(model, { name: "usage-qa" })] });
  const tokens: unknown[] = [], usage: unknown[] = [];
  g.events.subscribe(event => { if (event.type === "agent.token") tokens.push(event.data); if (event.type === "agent.usage") usage.push(event.data); });
  const result = await g.run();
  expect(result).toMatchObject({ status: "completed", usage: { totalTokens: 5, calls: 1 } });
  expect(tokens).toEqual([{ text: "hel" }, { text: "lo" }]); expect(usage).toHaveLength(1);
  expect(model.invoke).not.toHaveBeenCalled();
});

it("rejects an unaffordable known media estimate before purchasing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-budget-media-")); dirs.push(dir);
  const start = vi.fn(async () => ({ id: "job", done: [], costUSD: 0.02 }));
  const g = await compileGraph(spec([{ id: "image", type: "image", provider: "media-qa", with: { prompt: "cat" } }], { budget: { maxUSD: 0.01, onExceed: "fail" } }), { cwd: dir, mediaProviders: [{ name: "media-qa", vendor: "qa", modalities: ["image"], estimateCostUSD: () => 0.02, start }] });
  expect(await g.run()).toMatchObject({ status: "error", usage: { costUSD: 0, calls: 0 } }); expect(start).not.toHaveBeenCalled();
});

it("emits synchronous media completion with cost and includes it in run totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-cost-media-")); dirs.push(dir);
  const g = await compileGraph(spec([{ id: "image", type: "image", provider: "media-qa", with: { prompt: "cat" } }]), { cwd: dir, mediaProviders: [{ name: "media-qa", vendor: "qa", modalities: ["image"], start: async () => ({ id: "job", done: [], costUSD: 0.02 }) }] });
  const events: unknown[] = []; g.events.subscribe(event => { if (event.type === "custom.media.job") events.push(event.data); });
  expect(await g.run()).toMatchObject({ status: "completed", usage: { costUSD: 0.02, calls: 1 } });
  expect(events).toContainEqual(expect.objectContaining({ phase: "done", costUSD: 0.02 }));
});

it("serializes unknown-cost media admission under a hard cap, bounding fanout overshoot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-cost-fanout-")); dirs.push(dir);
  const start = vi.fn(async () => ({ id: "job", done: [], costUSD: 0.02 }));
  const g = await compileGraph(spec([{ id: "image", type: "image", provider: "media-qa", with: { prompt: "cat", count: 4 } }], { budget: { maxUSD: 0.01, onExceed: "fail" } }), { cwd: dir, mediaProviders: [{ name: "media-qa", vendor: "qa", modalities: ["image"], maxPerJob: { image: 1 }, start }] });
  expect(await g.run()).toMatchObject({ status: "error", usage: { costUSD: 0.02, calls: 1 } }); expect(start).toHaveBeenCalledTimes(1);
});

it("reports a timed-out in-flight call as pending, then records its eventual usage", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const model: ChatModelLike = { invoke: async () => { await hold; return message(4); } };
  const saver = new MemorySaver();
  const s = spec([{ ...agent(), timeout: "10ms" }]);
  const g = await compileGraph(s, { checkpointer: saver, providers: [createLangChainProvider(model, { name: "usage-qa" })] });
  let reported!: () => void;
  const charged = new Promise<void>(resolve => { reported = resolve; });
  g.events.subscribe(event => { if (event.type === "agent.usage") reported(); });
  try {
    expect(await g.run({ threadId: "timeout" })).toMatchObject({ status: "error", usage: { calls: 0, pendingCalls: 1 } });
  } finally { release(); }
  await charged;
  const { UsageLedger } = await import("./usage/ledger.js");
  expect((await UsageLedger.open(saver, "timeout")).snapshot()).toMatchObject({ totalTokens: 4, calls: 1, pendingCalls: 0 });
});

it("marks failed calls as unknown and prevents further calls under a hard budget", async () => {
  const model: ChatModelLike = { invoke: vi.fn(async () => { throw new Error("vendor connection lost"); }) };
  const g = await compileGraph(spec([{ ...agent(), retry: { maxAttempts: 3, baseMs: 1, jitter: false } }], { budget: { maxTokens: 100, onExceed: "fail" } }), { providers: [createLangChainProvider(model, { name: "usage-qa" })] });
  expect(await g.run()).toMatchObject({ status: "error", usage: { unknownCalls: 1, pendingCalls: 0 } });
  expect(model.invoke).toHaveBeenCalledTimes(1);
});

it("leaves a durable pending receipt when persisting completed usage fails", async () => {
  const { UsageLedger } = await import("./usage/ledger.js");
  const saver = new MemorySaver();
  let stored: import("./usage/ledger.js").UsageRecord | undefined;
  Object.assign(saver, {
    readThreadUsage: () => stored,
    writeThreadUsage: (_thread: string, record: import("./usage/ledger.js").UsageRecord) => {
      if (record.totals.calls > 0) throw new Error("disk unavailable");
      stored = JSON.parse(JSON.stringify(record));
    },
  });
  const model = fake([message(4)]);
  const g = await compileGraph(spec([agent()]), { checkpointer: saver, providers: [createLangChainProvider(model, { name: "usage-qa" })] });
  expect(await g.run({ threadId: "save-fail" })).toMatchObject({ status: "error", error: { code: "USAGE_WRITE_FAILED" }, usage: { pendingCalls: 1 } });
  expect((await UsageLedger.open(saver, "save-fail")).snapshot().pendingCalls).toBe(1);
  expect(model.invoke).toHaveBeenCalledTimes(1);
});

it("keeps concurrent threads' spend independent on one compiled graph", async () => {
  const provider = createScriptedProvider("usage-qa", async () => ({ output: "done", stopReason: "done", usage: { totalTokens: 7, costUSD: 0.002 } }));
  const g = await compileGraph(spec([agent()], { budget: { maxUSD: 0.003, onExceed: "fail" } }), { providers: [provider] });
  const results = await Promise.all([g.run({ threadId: "one" }), g.run({ threadId: "two" })]);
  for (const result of results) expect(result).toMatchObject({ status: "completed", usage: { calls: 1, totalTokens: 7, costUSD: 0.002 } });
});

it("charges native structured finalization as a separate call without duplicate events", async () => {
  const model = fake([message(6)]);
  model.withStructuredOutput = () => ({ invoke: async () => ({ parsed: { answer: "done" }, raw: message(4) }) });
  registerTool({ name: "usage_tool", handler: () => "fact" });
  const g = await compileGraph(spec([agent("a", { tools: [{ function: "usage_tool" }], schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } })]), { providers: [createLangChainProvider(model, { name: "usage-qa" })] });
  const usage: unknown[] = []; g.events.subscribe(e => { if (e.type === "agent.usage") usage.push(e.data); });
  expect(await g.run()).toMatchObject({ status: "completed", usage: { calls: 2, totalTokens: 10 } }); expect(usage).toHaveLength(2);
});

it("does not treat a cost-only provider response as known zero tokens under a hard token cap", async () => {
  const provider = createScriptedProvider("usage-qa", () => ({ output: "done", stopReason: "done", usage: { costUSD: 0.002 } }));
  const g = await compileGraph(spec([agent()], { budget: { maxTokens: 100, onExceed: "fail" } }), { providers: [provider] });
  expect(await g.run()).toMatchObject({ status: "error", error: { code: "USAGE_UNRESOLVED" }, usage: { costUSD: 0.002, unreportedTokenCalls: 1 } });
});

it("allows no-budget continuation and atomically merges a timed-out call's late usage", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const saver = new MemorySaver();
  const first = await compileGraph(spec([{ ...agent(), timeout: "10ms" }]), { checkpointer: saver, providers: [createLangChainProvider({ invoke: async () => { await hold; return message(4); } }, { name: "usage-qa" })] });
  let reported!: () => void; const charged = new Promise<void>(resolve => { reported = resolve; });
  first.events.subscribe(event => { if (event.type === "agent.usage") reported(); });
  try {
    expect(await first.run({ threadId: "late" })).toMatchObject({ status: "error", usage: { pendingCalls: 1 } });
    const next = await compileGraph(spec([agent()]), { checkpointer: saver, providers: [createLangChainProvider(fake([message(5)]), { name: "usage-qa" })] });
    expect(await next.resume({ threadId: "late", resume: true })).toMatchObject({ status: "completed", usage: { totalTokens: 5, pendingCalls: 1 } });
  } finally { release(); }
  await charged;
  const { inspectThreadUsage } = await import("./usage/ledger.js");
  expect((await inspectThreadUsage(saver, "late")).totals).toMatchObject({ totalTokens: 9, calls: 2 });
  expect((await inspectThreadUsage(saver, "late")).pending).toEqual({});
});

it.each([401, 403, 429, "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])("retries known-zero rejected requests under a hard budget (%s)", async rejection => {
  const invoke = vi.fn().mockRejectedValueOnce(Object.assign(new Error("request rejected"), typeof rejection === "number" ? { status: rejection } : { code: rejection })).mockResolvedValue(message(4));
  const g = await compileGraph(spec([{ ...agent(), retry: { maxAttempts: 2, baseMs: 1, jitter: false } }], { budget: { maxTokens: 5, onExceed: "fail" } }), { providers: [createLangChainProvider({ invoke }, { name: "usage-qa" })] });
  expect(await g.run()).toMatchObject({ status: "completed", usage: { totalTokens: 4, calls: 2, unknownCalls: 0, pendingCalls: 0 } });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("can reconcile an ambiguous failure and resume a hard-budget thread without double charging", async () => {
  const { inspectThreadUsage, resolveThreadUsage } = await import("./usage/ledger.js");
  const saver = new MemorySaver();
  const invoke = vi.fn().mockRejectedValueOnce(Object.assign(new Error("socket lost"), { code: "ECONNRESET" })).mockResolvedValue(message(4));
  const s = spec([agent()], { budget: { maxTokens: 10, onExceed: "fail" } });
  const provider = createLangChainProvider({ invoke }, { name: "usage-qa" });
  const g = await compileGraph(s, { checkpointer: saver, providers: [provider] });
  expect((await g.run({ threadId: "resolve" })).status).toBe("error");
  const id = Object.keys((await inspectThreadUsage(saver, "resolve")).unresolved!)[0]!;
  await resolveThreadUsage(saver, "resolve", id, { totalTokens: 3, costUSD: 0.002 });
  await expect(resolveThreadUsage(saver, "resolve", id, { totalTokens: 3, costUSD: 0.002 })).rejects.toMatchObject({ code: "USAGE_RECEIPT_RESOLVED" });
  expect(await g.resume({ threadId: "resolve", resume: true })).toMatchObject({ status: "completed", usage: { totalTokens: 7, calls: 2, unknownCalls: 0 } });
});

it.each([false, null, { approved: false }])("does not purchase after a denied budget interrupt (%j)", async answer => {
  const dir = await mkdtemp(join(tmpdir(), "fg-budget-deny-")); dirs.push(dir);
  const start = vi.fn(async () => ({ id: "job", done: [], costUSD: 0.02 }));
  const g = await compileGraph(spec([{ id: "image", type: "image", provider: "media-qa", with: { prompt: "cat" } }], { budget: { maxUSD: 0.01, onExceed: "interrupt" } }), { cwd: dir, mediaProviders: [{ name: "media-qa", vendor: "qa", modalities: ["image"], estimateCostUSD: () => 0.02, start }] });
  expect((await g.run({ threadId: "denied" })).status).toBe("interrupted");
  expect(await g.resume({ threadId: "denied", resume: answer })).toMatchObject({ status: "error", error: { code: "BUDGET_DENIED" }, usage: { calls: 0 } });
  expect(start).not.toHaveBeenCalled();
});


it("does not charge a late response twice after the pending receipt was explicitly reconciled", async () => {
  const { inspectThreadUsage, resolveThreadUsage } = await import("./usage/ledger.js");
  let release!: () => void, finished!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), done = new Promise<void>(resolve => { finished = resolve; });
  const provider = createScriptedProvider("usage-qa", async (_req, ctx) => {
    const usage = await ctx.meterCall!(async () => { await hold; return { totalTokens: 4, costUSD: 0 }; }, { usage: value => value });
    finished(); return { output: "done", stopReason: "done", usage };
  });
  provider.capabilities.callAccounting = true;
  const saver = new MemorySaver(), g = await compileGraph(spec([{ ...agent(), timeout: "10ms" }]), { checkpointer: saver, providers: [provider] });
  expect((await g.run({ threadId: "reconciled-late" })).status).toBe("error");
  const receipt = Object.keys((await inspectThreadUsage(saver, "reconciled-late")).pending)[0]!;
  try { await resolveThreadUsage(saver, "reconciled-late", receipt, { totalTokens: 4, costUSD: 0 }); }
  finally { release(); }
  await done;
  expect((await inspectThreadUsage(saver, "reconciled-late")).totals).toMatchObject({ calls: 1, totalTokens: 4 });
});

it("can reconcile an older ledger that retained only uncertainty counters", async () => {
  const { emptyUsage, inspectThreadUsage, resolveThreadUsage } = await import("./usage/ledger.js");
  const { pendingCalls: _, ...totals } = emptyUsage();
  let stored: import("./usage/ledger.js").UsageRecord = { version: 1, totals: { ...totals, calls: 2, totalTokens: 7, costUSD: 0.002, unknownCalls: 1, unreportedTokenCalls: 1, unpricedCalls: 1 }, pending: {} };
  const saver = { readThreadUsage: () => stored, writeThreadUsage: (_thread: string, record: typeof stored) => { stored = JSON.parse(JSON.stringify(record)); } };
  expect((await inspectThreadUsage(saver, "legacy")).unresolved).toHaveProperty("legacy-unreported");
  const resolved = await resolveThreadUsage(saver, "legacy", "legacy-unreported", { totalTokens: 3, costUSD: 0.001 });
  expect(resolved.totals).toMatchObject({ calls: 2, totalTokens: 10, costUSD: 0.003, unknownCalls: 0, unpricedCalls: 0, unreportedTokenCalls: 0 });
  await expect(resolveThreadUsage(saver, "legacy", "legacy-unreported", { totalTokens: 3, costUSD: 0.001 })).rejects.toMatchObject({ code: "USAGE_RECEIPT_RESOLVED" });
});

it("retains partial streamed usage and never classifies a post-response 429 as known zero", async () => {
  const stream = vi.fn(async function* () {
    yield new AIMessageChunk({ content: "part", usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } as ConstructorParameters<typeof AIMessageChunk>[0]);
    throw Object.assign(new Error("late stream failure"), { status: 429 });
  });
  const model: ChatModelLike = { invoke: vi.fn(async () => message(4)), stream };
  const g = await compileGraph(spec([{ ...agent("a", { streaming: true }), retry: { maxAttempts: 2, baseMs: 1, jitter: false } }], { budget: { maxTokens: 10, onExceed: "fail" } }), { providers: [createLangChainProvider(model, { name: "usage-qa" })] });
  expect(await g.run()).toMatchObject({ status: "error", usage: { calls: 1, totalTokens: 4, unknownCalls: 1 } });
  expect(stream).toHaveBeenCalledTimes(1);
});
