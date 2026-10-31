import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { registerTokenEstimator, registerTool } from "../index.js";
import { ReplayStore } from "../providers/replay-cache.js";
import { cachedContextArtefact } from "./context-replay.js";
import { createLangChainProvider, type ChatModelLike } from "../providers/langchain/index.js";
import { createScriptedProvider } from "../providers/index.js";
import type { NodePolicy } from "../node-policy.js";
import "./index.js";

// A context budget on the replay path: an agent that interrupts before every
// tool call and is resumed by a freshly compiled graph each time must send the
// model exactly what one straight run sends, with cached tool results and
// cached summaries, at the top level and inside a node called as a tool.

const POLICY: NodePolicy = {
  blockedTypes: ["shell", "script", "service", "worktree", "skill", "demo", "mcp"],
  blockHostExec: true,
  blockAgentRefs: true,
  blockImports: true,
  blockInboundWebhooks: true,
  allowedFunctions: [],
  reason: "test policy",
};

const STEPS = 6;
let toolRuns = 0;
beforeAll(() => {
  registerTokenEstimator("ctxr-dense", (t) => Math.ceil(t.length / 2.5));
  registerTool({ name: "ctxr_short", handler: (args) => ({ page: (args as { page: number }).page, lines: "S".repeat(2000) }) });
  registerTool({ name: "ctxr_page", handler: (args) => ({ n: ++toolRuns, page: (args as { page: number }).page, lines: "P".repeat(12_000) }) });
});

/** Scripted chat model; only live calls are recorded (replayed turns are not sent). */
function model(script: (i: number) => AIMessage) {
  const calls: BaseMessage[][] = [];
  const m: ChatModelLike = {
    async invoke(input: BaseMessage[]) {
      calls.push([...input]);
      return script(calls.length - 1);
    },
    bindTools() {
      return this;
    },
  };
  return { m, calls };
}

const pageCall = (i: number) => new AIMessage({ content: "", tool_calls: [{ name: "ctxr_page", args: { page: i }, id: `page_${i}` }] });
const looper = (i: number) => (i < STEPS ? pageCall(i) : new AIMessage({ content: "done" }));
const strip = (calls: BaseMessage[][]) => calls.map((c) => c.map((m) => [m._getType(), typeof m.content === "string" ? m.content : JSON.stringify(m.content)]));
const CONTEXT = { maxTokens: 6000, strategy: "summarize", toolResultMaxTokens: 1500, summarize: { provider: "ctxr-cheap", maxTokens: 200 } };

function seeds(n = 12): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new HumanMessage({ id: `seed-u${i}`, content: `question ${i} ${"q".repeat(400)}` }));
    out.push(new AIMessage({ id: `seed-a${i}`, content: `answer ${i} ${"a".repeat(400)}` }));
  }
  return out;
}

/** Runs the graph to the end, approving every interrupt and compiling a new graph for each resume. */
async function runAll(build: (permission: "auto" | "ask") => GraphSpec, permission: "auto" | "ask", models: Record<string, (i: number) => AIMessage>, input: Record<string, unknown> = {}) {
  toolRuns = 0;
  let summaries = 0;
  const cheap = createScriptedProvider("ctxr-cheap", (req) => {
    summaries++;
    return { output: `summary of ${req.prompt.length} chars`, stopReason: "done" };
  });
  const fakes = Object.fromEntries(Object.entries(models).map(([name, s]) => [name, model(s)]));
  const providers = [cheap, ...Object.entries(fakes).map(([name, f]) => createLangChainProvider(f.m, { name }))];
  const saver = new MemorySaver();
  const compile = () => compileGraph(build(permission), { checkpointer: saver, providers, nodePolicy: POLICY });
  const threadId = `ctxr-${randomUUID()}`;
  let r = await (await compile()).run({ threadId, input, onInterrupt: "fail" });
  let resumes = 0;
  while (r.status === "interrupted" && resumes < 20) {
    r = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
    resumes++;
  }
  return { r, fakes, summaries, toolRuns, resumes };
}

describe("context budget across interrupt and resume", () => {
  const topLevel = (permission: "auto" | "ask") =>
    ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "ctxr-top" },
      state: { channels: { chat: { type: "messages" }, answer: { type: "object" } } },
      nodes: [
        {
          id: "investigate",
          type: "agent",
          provider: "ctxr-model",
          with: { prompt: "Find the cause.", tools: [{ function: "ctxr_page" }], maxSteps: 40, permission, context: { history: "chat", ...CONTEXT }, output: { to: "answer" } },
        },
      ],
      edges: [
        { from: "START", to: "investigate" },
        { from: "investigate", to: "END" },
      ],
    }) as unknown as GraphSpec;

  it("a history agent under the untrusted node policy sends the same trimmed and summarized inputs, and writes the same summary message", async () => {
    const auto = await runAll(topLevel, "auto", { "ctxr-model": looper }, { chat: seeds() });
    const ask = await runAll(topLevel, "ask", { "ctxr-model": looper }, { chat: seeds() });
    expect(auto.r.error?.message).toBeUndefined();
    expect(ask.r.error?.message).toBeUndefined();
    expect([auto.r.status, ask.r.status]).toEqual(["completed", "completed"]);
    expect(ask.resumes).toBeGreaterThanOrEqual(STEPS);
    expect(ask.toolRuns).toBe(STEPS);
    expect(auto.summaries).toBeGreaterThan(0);
    expect(ask.summaries).toBe(auto.summaries);
    const a = strip(auto.fakes["ctxr-model"]!.calls);
    expect(a.length).toBe(STEPS + 1);
    expect(strip(ask.fakes["ctxr-model"]!.calls)).toEqual(a);
    const chatOf = (r: typeof auto.r) => ((r.state as { chat?: BaseMessage[] }).chat ?? []).map((m) => [m.id, m.content]);
    expect(chatOf(auto.r).map(([id]) => id)).toContain("fg-summary-chat-investigate");
    expect(chatOf(ask.r)).toEqual(chatOf(auto.r));
  });

  it("an agent inside a subgraph called as a tool resumes with the same context and summaries", async () => {
    const child = (permission: "auto" | "ask") => ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "ctxr-child" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [
        {
          id: "inner",
          type: "agent",
          provider: "ctxr-inner",
          with: { prompt: "Dig in.", tools: [{ function: "ctxr_page" }], maxSteps: 40, permission, context: CONTEXT, output: { to: "answer" } },
        },
      ],
      edges: [
        { from: "START", to: "inner" },
        { from: "inner", to: "END" },
      ],
    });
    const outer = (permission: "auto" | "ask") =>
      ({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "ctxr-sg-tool" },
        state: { channels: { out: { type: "object" } } },
        nodes: [
          { id: "lead", type: "agent", provider: "ctxr-outer", with: { prompt: "Delegate.", tools: [{ node: "dig" }], output: { to: "out" } } },
          { id: "dig", type: "subgraph", when: "false", spec: child(permission), with: { output: "none" } },
        ],
        edges: [
          { from: "START", to: "lead" },
          { from: "lead", to: "END" },
          { from: "START", to: "dig" },
          { from: "dig", to: "END" },
        ],
      }) as unknown as GraphSpec;
    const lead = (i: number) => (i === 0 ? new AIMessage({ content: "", tool_calls: [{ name: "dig", args: {}, id: "dig_0" }] }) : new AIMessage({ content: "lead done" }));
    const models = { "ctxr-outer": lead, "ctxr-inner": looper };
    const auto = await runAll(outer, "auto", models);
    const ask = await runAll(outer, "ask", models);
    expect(auto.r.error?.message).toBeUndefined();
    expect(ask.r.error?.message).toBeUndefined();
    expect([auto.r.status, ask.r.status]).toEqual(["completed", "completed"]);
    expect(ask.resumes).toBeGreaterThanOrEqual(STEPS);
    expect(ask.toolRuns).toBe(STEPS);
    expect(auto.summaries).toBeGreaterThan(0);
    expect(ask.summaries).toBe(auto.summaries);
    const inner = strip(auto.fakes["ctxr-inner"]!.calls);
    expect(inner.length).toBe(STEPS + 1);
    expect(strip(ask.fakes["ctxr-inner"]!.calls)).toEqual(inner);
    expect(strip(ask.fakes["ctxr-outer"]!.calls)).toEqual(strip(auto.fakes["ctxr-outer"]!.calls));
    expect(ask.fakes["ctxr-outer"]!.calls.length).toBe(2);
  });

  it("refuses a __ history channel under the same policy", async () => {
    const spec = topLevel("auto") as unknown as { nodes: Array<{ with: { context: Record<string, unknown> } }> };
    spec.nodes[0]!.with.context = { ...spec.nodes[0]!.with.context, history: "__chat" };
    const p = createScriptedProvider("ctxr-model", () => ({ output: "x", stopReason: "done" }));
    await expect(compileGraph(spec as unknown as GraphSpec, { providers: [p], nodePolicy: POLICY })).rejects.toThrow(/reserved|__chat/);
  });
});

// A resume may compile a different spec (the server accepts a new YAML on
// resume). Whatever changed, the resumed run must fold and summarize exactly
// what a straight run of the new spec does: a summary cached under the old
// settings must not be reused for the messages the new fit folds.
describe("context settings changed between interrupt and resume", () => {
  const SHORT_STEPS = 2;
  const shortLoop = (i: number) =>
    i < SHORT_STEPS ? new AIMessage({ content: "", tool_calls: [{ name: "ctxr_short", args: { page: i }, id: `s_${i}` }] }) : new AIMessage({ content: "done" });
  function marked(n: number): BaseMessage[] {
    const out: BaseMessage[] = [];
    for (let i = 0; i < n; i++) {
      out.push(new HumanMessage({ id: `m-u${i}`, content: `question Q${i}Q ${"q".repeat(400)}` }));
      out.push(new AIMessage({ id: `m-a${i}`, content: `answer ${i} ${"a".repeat(400)}` }));
    }
    return out;
  }
  type Ctx = Record<string, unknown>;
  const spec = (permission: "auto" | "ask", context: Ctx) =>
    ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "ctxr-change" },
      state: { channels: { chat: { type: "messages" }, answer: { type: "object" } } },
      nodes: [
        {
          id: "inv",
          type: "agent",
          provider: "ctxr-model",
          with: {
            prompt: "Go.",
            tools: [{ function: "ctxr_short" }],
            maxSteps: 20,
            permission,
            context: { history: "chat", strategy: "summarize", toolResultMaxTokens: 200, summarize: { provider: "ctxr-cover", maxTokens: 300 }, ...context },
            output: { to: "answer" },
          },
        },
      ],
      edges: [
        { from: "START", to: "inv" },
        { from: "inv", to: "END" },
      ],
    }) as unknown as GraphSpec;

  /** Runs with `contexts[i]` for the i-th compile (the first run, then each resume). */
  async function run(permission: "auto" | "ask", contexts: Ctx[], seeds = 60) {
    let calls = 0;
    // Lists the questions it was shown (the previous summary included) and the
    // size of its instructions, so a summary made from other inputs shows.
    const cover = createScriptedProvider("ctxr-cover", (req) => {
      calls++;
      const qs = [...new Set([...req.prompt.matchAll(/Q(\d+)Q/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
      return { output: `covers ${qs.map((q) => `Q${q}Q`).join(" ")} (instructions ${req.system?.length ?? 0})`, stopReason: "done" };
    });
    const fake = model(shortLoop);
    const providers = [cover, createLangChainProvider(fake.m, { name: "ctxr-model" })];
    const saver = new MemorySaver();
    let i = 0;
    const compile = () => compileGraph(spec(permission, contexts[Math.min(i++, contexts.length - 1)]!), { checkpointer: saver, providers, nodePolicy: POLICY });
    const threadId = `ctxr-change-${randomUUID()}`;
    let r = await (await compile()).run({ threadId, input: { chat: marked(seeds) }, onInterrupt: "fail" });
    let resumes = 0;
    while (r.status === "interrupted" && resumes < 10) {
      r = await (await compile()).resume({ threadId, resume: true, onInterrupt: "fail" });
      resumes++;
    }
    expect(r.error?.message).toBeUndefined();
    expect(r.status).toBe("completed");
    const chat = (r.state as { chat?: BaseMessage[] }).chat ?? [];
    const summary = chat.find((m) => m.id === "fg-summary-chat-inv");
    const text = String((summary?.additional_kwargs as { flowgraph?: { text?: string } } | undefined)?.flowgraph?.text ?? "");
    const covered = new Set([...text.matchAll(/Q(\d+)Q/g)].map((m) => Number(m[1])));
    const ids = new Set(chat.map((m) => m.id));
    const removed = [...Array(seeds).keys()].filter((q) => !ids.has(`m-u${q}`));
    return { chat: chat.map((m) => [m.id, m.content]), removed, covered, calls, resumes, inputs: fake.calls };
  }

  async function expectLikeStraight(before: Ctx, after: Ctx) {
    const straight = await run("auto", [after]);
    const resumed = await run("ask", [before, after]);
    expect(resumed.resumes).toBeGreaterThanOrEqual(SHORT_STEPS);
    expect(straight.removed.length).toBeGreaterThan(0);
    // Every message removed from the channel is in the summary just as in a
    // straight run (the scripted summary only lists what it was shown).
    expect(resumed.removed).toEqual(straight.removed);
    expect(resumed.removed.filter((q) => !resumed.covered.has(q))).toEqual(straight.removed.filter((q) => !straight.covered.has(q)));
    expect([...resumed.covered]).toEqual([...straight.covered]);
    expect(resumed.chat).toEqual(straight.chat);
  }

  it("a lower budget on resume (9000 then 4000)", () => expectLikeStraight({ maxTokens: 9000 }, { maxTokens: 4000 }));
  it("a higher budget on resume (4000 then 9000)", () => expectLikeStraight({ maxTokens: 4000 }, { maxTokens: 9000 }));
  it("another estimator on resume", () => expectLikeStraight({ maxTokens: 6000 }, { maxTokens: 6000, estimator: "ctxr-dense" }));
  it("other summary settings on resume", () =>
    expectLikeStraight(
      { maxTokens: 4000 },
      { maxTokens: 4000, summarize: { provider: "ctxr-cover", maxTokens: 200, instructions: "Keep every question number." } },
    ));

  it("the same spec reuses the cached summaries instead of making them again", async () => {
    const straight = await run("auto", [{ maxTokens: 4000 }]);
    const resumed = await run("ask", [{ maxTokens: 4000 }]);
    expect(resumed.resumes).toBeGreaterThanOrEqual(SHORT_STEPS);
    expect(straight.calls).toBeGreaterThan(0);
    expect(resumed.calls).toBe(straight.calls);
    expect(resumed.chat).toEqual(straight.chat);
  });
});

describe("cachedContextArtefact", () => {
  const isString = (v: unknown): v is string => typeof v === "string";
  it("reuses an entry made from the same inputs and remakes one made from others", async () => {
    const store = new ReplayStore();
    let made = 0;
    const make = (text: string) => async () => {
      made++;
      return text;
    };
    expect(await cachedContextArtefact(store, "k", "summary", 0, { a: 1, b: [1, 2] }, isString, make("one"))).toBe("one");
    expect(await cachedContextArtefact(store, "k", "summary", 0, { b: [1, 2], a: 1 }, isString, make("two"))).toBe("one");
    expect(made).toBe(1);
    expect(await cachedContextArtefact(store, "k", "summary", 0, { a: 2, b: [1, 2] }, isString, make("three"))).toBe("three");
    expect(made).toBe(2);
    // Positions and kinds are separate entries.
    expect(await cachedContextArtefact(store, "k", "summary", 1, { a: 2, b: [1, 2] }, isString, make("four"))).toBe("four");
    expect(await cachedContextArtefact(store, "k", "other", 0, { a: 2, b: [1, 2] }, isString, make("five"))).toBe("five");
    expect(made).toBe(4);
  });

  it("remakes an entry with no input hash (a bare cached string) or a value of the wrong type", async () => {
    const store = new ReplayStore();
    store.set("k", "ctx:summary:0", "old text");
    expect(await cachedContextArtefact(store, "k", "summary", 0, {}, isString, async () => "new")).toBe("new");
    store.set("k", "ctx:summary:0", { inputHash: "x", value: 7 });
    expect(await cachedContextArtefact(store, "k", "summary", 0, {}, isString, async () => "newer")).toBe("newer");
  });
});

describe("summary provider and summary messages", () => {
  const graph = (context: Record<string, unknown>) =>
    ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "ctxr-guard" },
      state: { channels: { chat: { type: "messages" }, answer: { type: "object" } } },
      nodes: [{ id: "inv", type: "agent", provider: "ctxr-model", with: { prompt: "Go.", context: { history: "chat", ...context }, output: { to: "answer" } } }],
      edges: [
        { from: "START", to: "inv" },
        { from: "inv", to: "END" },
      ],
    }) as unknown as GraphSpec;
  const plainSeeds = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      new HumanMessage({ id: `g-u${i}`, content: `question G${i}G` }),
      new AIMessage({ id: `g-a${i}`, content: `answer ${i}` }),
    ]).flat();

  for (const policy of [POLICY, undefined]) {
    it(`a summarize.provider the graph cannot use fails the node before any model call${policy ? " (node policy)" : ""}`, async () => {
      const fake = model(() => new AIMessage({ content: "done" }));
      const g = await compileGraph(graph({ maxTokens: 400, strategy: "summarize", summarize: { provider: "ctxr-missing" } }), {
        providers: [createLangChainProvider(fake.m, { name: "ctxr-model" })],
        ...(policy ? { nodePolicy: policy } : {}),
      });
      const r = await g.run({ threadId: `ctxr-g-${randomUUID()}`, input: { chat: plainSeeds(20) } });
      expect(r.status).toBe("error");
      expect(r.error?.message).toMatch(/summarize\.provider "ctxr-missing" is not registered/);
      expect(fake.calls.length).toBe(0);
    });
  }
});
