import { describe, it, expect } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { compileGraph, registerTool, type GraphSpec } from "../../index.js";
import { createLangChainProvider, type ChatModelLike } from "./index.js";

/** A minimal fake chat model: returns scripted AIMessages in sequence. */
function fakeModel(
  responses: AIMessage[],
  onBindTools?: (tools: unknown[]) => void,
): ChatModelLike {
  let i = 0;
  const model: ChatModelLike = {
    async invoke(_input: BaseMessage[]) {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r!;
    },
    bindTools(tools: unknown[]) {
      onBindTools?.(tools);
      return model;
    },
  };
  return model;
}

const spec: GraphSpec = {
  metadata: { name: "lc-graph" },
  state: { channels: { answer: { type: "object" } } },
  nodes: [{ id: "agent", type: "agent", provider: "langchain", with: { prompt: "Hi", output: { to: "answer" } } }],
  edges: [
    { from: "START", to: "agent" },
    { from: "agent", to: "END" },
  ],
  runtime: { checkpoint: { enabled: false } },
} as unknown as GraphSpec;

describe("LangChain provider (built into @flowgraph/core)", () => {
  it("returns model text when there are no tool calls", async () => {
    const model = fakeModel([new AIMessage({ content: "All done." })]);
    const provider = createLangChainProvider(model);
    const compiled = await compileGraph(spec, { providers: [provider] });

    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state["answer"] as { text: string }).text).toBe("All done.");
  });

  it("executes a tool call then finishes (hub & spoke loop)", async () => {
    registerTool({ name: "weather", handler: () => ({ tempF: 72 }) });

    const bound: unknown[] = [];
    const model = fakeModel(
      [
        new AIMessage({ content: "", tool_calls: [{ name: "weather", args: { city: "SF" }, id: "t1" }] }),
        new AIMessage({ content: "It is 72F in SF." }),
      ],
      (tools) => {
        bound.push(...tools);
      },
    );
    const provider = createLangChainProvider(model);
    const toolSpec = {
      ...spec,
      nodes: [{ id: "agent", type: "agent", provider: "langchain", with: { prompt: "weather?", tools: [{ function: "weather" }], output: { to: "answer" } } }],
    } as unknown as GraphSpec;

    const events: string[] = [];
    const compiled = await compileGraph(toolSpec, { providers: [provider], sinks: [(e) => { events.push(e.type); }] });
    const r = await compiled.run({ input: {} });

    expect(r.status).toBe("completed");
    expect((r.state["answer"] as { text: string }).text).toBe("It is 72F in SF.");
    expect(events).toContain("agent.tool.call");
    // Bedrock Converse (and similar) require DynamicStructuredTool, not plain objects.
    expect(bound.length).toBeGreaterThan(0);
    const names = bound.map((t) => (t as { name?: string }).name);
    expect(names).toContain("weather");
    expect(names).toContain("report_issue");
    for (const t of bound) {
      expect(typeof (t as { invoke?: unknown }).invoke === "function" || typeof (t as { func?: unknown }).func === "function").toBe(true);
    }
  });

  it("reports stopReason maxSteps and emits custom.agent.maxSteps when the loop is exhausted", async () => {
    registerTool({ name: "spin", handler: () => ({ ok: true }) });
    const model = fakeModel([
      new AIMessage({ content: "", tool_calls: [{ name: "spin", args: {}, id: "t1" }] }),
    ]);
    const provider = createLangChainProvider(model);
    const loopSpec = {
      ...spec,
      nodes: [{
        id: "agent",
        type: "agent",
        provider: "langchain",
        with: { prompt: "loop", tools: [{ function: "spin" }], maxSteps: 2, output: { to: "answer" } },
      }],
    } as unknown as GraphSpec;

    const events: string[] = [];
    const compiled = await compileGraph(loopSpec, {
      providers: [provider],
      sinks: [(e) => { events.push(e.type); }],
    });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(events).toContain("custom.agent.maxSteps");
  });

  it("replays cached LLM responses and tool results across permission:ask resume", async () => {
    let toolRuns = 0;
    registerTool({
      name: "lookup-once",
      handler: () => {
        toolRuns += 1;
        return { fact: "cached" };
      },
    });

    let invokes = 0;
    const responses = [
      new AIMessage({ content: "", tool_calls: [{ name: "lookup-once", args: {}, id: "t1" }] }),
      new AIMessage({ content: "The fact is cached." }),
    ];
    const model: ChatModelLike = {
      async invoke(_input: BaseMessage[]) {
        const r = responses[Math.min(invokes, responses.length - 1)];
        invokes += 1;
        return r!;
      },
      bindTools() {
        return this;
      },
    };
    const provider = createLangChainProvider(model);
    const askSpec = {
      metadata: { name: "ask-replay" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [{
        id: "agent",
        type: "agent",
        provider: "langchain",
        with: {
          prompt: "look it up",
          tools: [{ function: "lookup-once" }],
          permission: "ask",
          output: { to: "answer" },
        },
      }],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(askSpec, { providers: [provider] });
    const threadId = `ask-replay-${Date.now()}`;
    const first = await compiled.run({ input: {}, threadId, onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");
    expect(invokes).toBe(1);
    expect(toolRuns).toBe(0);

    const resumed = await compiled.resume({ threadId, resume: true, onInterrupt: "fail" });
    expect(resumed.status).toBe("completed");
    expect((resumed.state["answer"] as { text: string }).text).toBe("The fact is cached.");
    expect(invokes).toBe(2);
    expect(toolRuns).toBe(1);
  });

  it("a fresh start on the same thread does not replay the abandoned run's cache", async () => {
    registerTool({ name: "lookup-stale", handler: () => ({ fact: "x" }) });

    let invokes = 0;
    const model: ChatModelLike = {
      async invoke(_input: BaseMessage[]) {
        invokes += 1;
        // First run: tool call (interrupts on permission ask). Any later call: finish.
        return invokes === 1
          ? new AIMessage({ content: "", tool_calls: [{ name: "lookup-stale", args: {}, id: "t1" }] })
          : new AIMessage({ content: "Fresh answer." });
      },
      bindTools() {
        return this;
      },
    };
    const provider = createLangChainProvider(model);
    const askSpec = {
      metadata: { name: "ask-stale" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [{
        id: "agent",
        type: "agent",
        provider: "langchain",
        with: {
          prompt: "look it up",
          tools: [{ function: "lookup-stale" }],
          permission: "ask",
          output: { to: "answer" },
        },
      }],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(askSpec, { providers: [provider] });
    const threadId = `ask-stale-${Date.now()}`;
    const first = await compiled.run({ input: {}, threadId, onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");
    expect(invokes).toBe(1);

    // Abandon the interrupt and start over on the same thread. The cached
    // llm:0 tool-call response from the abandoned run must not be replayed —
    // the model should be consulted again and the run should complete.
    const second = await compiled.run({ input: {}, threadId, onInterrupt: "fail" });
    expect(second.status).toBe("completed");
    expect((second.state["answer"] as { text: string }).text).toBe("Fresh answer.");
    expect(invokes).toBe(2);
  });

  it("survives process restart by hydrating replay from the interrupt payload", async () => {
    let toolRuns = 0;
    registerTool({
      name: "lookup-restart",
      handler: () => {
        toolRuns += 1;
        return { fact: "restarted" };
      },
    });

    let invokes = 0;
    const responses = [
      new AIMessage({ content: "", tool_calls: [{ name: "lookup-restart", args: {}, id: "t1" }] }),
      new AIMessage({ content: "Restarted fact." }),
    ];
    const model: ChatModelLike = {
      async invoke() {
        const r = responses[Math.min(invokes, responses.length - 1)];
        invokes += 1;
        return r!;
      },
      bindTools() {
        return this;
      },
    };
    const provider = createLangChainProvider(model);
    const askSpec = {
      metadata: { name: "ask-restart" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [{
        id: "agent",
        type: "agent",
        provider: "langchain",
        with: {
          prompt: "look it up",
          tools: [{ function: "lookup-restart" }],
          permission: "ask",
          output: { to: "answer" },
        },
      }],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(askSpec, { providers: [provider] });
    const threadId = `ask-restart-${Date.now()}`;
    const first = await compiled.run({ input: {}, threadId, onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");
    expect(invokes).toBe(1);

    const { clearAllReplayCaches } = await import("../replay-cache.js");
    clearAllReplayCaches();

    const resumed = await compiled.resume({ threadId, resume: true, onInterrupt: "fail" });
    expect(resumed.status).toBe("completed");
    expect((resumed.state["answer"] as { text: string }).text).toBe("Restarted fact.");
    expect(invokes).toBe(2);
    expect(toolRuns).toBe(1);
  });
});
