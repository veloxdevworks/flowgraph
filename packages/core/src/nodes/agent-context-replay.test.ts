import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { registerTool } from "../index.js";
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
