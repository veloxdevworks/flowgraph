import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerTool, createScriptedProvider, mockProvider } from "./providers/index.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

beforeAll(() => {
  registerTool({
    name: "lookup",
    description: "Look up a fact",
    handler: (args) => ({ fact: `value for ${JSON.stringify(args)}` }),
  });
});

function spec(nodeWith: Record<string, unknown>, provider = "mock", model?: string): GraphSpec {
  return {
    metadata: { name: "agent-graph" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [
      { id: "agent", type: "intelligent", provider, ...(model ? { model } : {}), with: nodeWith },
    ],
    edges: [
      { from: "START", to: "agent" },
      { from: "agent", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("intelligent node + mock provider", () => {
  it("runs the agent loop and writes structured output", async () => {
    const compiled = await compileGraph(
      spec({
        prompt: "Summarize the work.",
        schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
        output: { to: "answer" },
      }),
      { providers: [mockProvider] },
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state["answer"] as { summary: string }).summary).toContain("Summarize");
  });

  it("invokes a function tool (hub & spoke)", async () => {
    const events: string[] = [];
    const compiled = await compileGraph(
      spec({
        prompt: "Find the fact.",
        tools: [{ function: "lookup" }],
        output: { to: "answer" },
      }),
      { providers: [mockProvider], sinks: [(e) => { events.push(e.type); }] },
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const answer = r.state["answer"] as { toolResults: Record<string, unknown> };
    expect(answer.toolResults["lookup"]).toMatchObject({ fact: expect.stringContaining("value for") });
    expect(events).toContain("intelligent.tool.call");
    expect(events).toContain("intelligent.tool.result");
    expect(events).toContain("intelligent.usage");
  });

  it("uses a scripted provider for deterministic output", async () => {
    const scripted = createScriptedProvider("scripted", () => ({
      output: { label: "bug" },
      stopReason: "done",
      usage: { totalTokens: 10 },
    }));
    const compiled = await compileGraph(
      spec({ prompt: "classify", output: { to: "answer" } }, "scripted"),
      { providers: [scripted] },
    );
    const r = await compiled.run({ input: {} });
    expect((r.state["answer"] as { label: string }).label).toBe("bug");
  });

  it("errors clearly when the provider is not registered", async () => {
    const compiled = await compileGraph(spec({ prompt: "hi", output: { to: "answer" } }, "ghost"), {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain('provider "ghost" is not registered');
  });

  it("permission deny blocks all tool calls", async () => {
    const compiled = await compileGraph(
      spec({
        prompt: "Find the fact.",
        tools: [{ function: "lookup" }],
        permission: "deny",
        output: { to: "answer" },
      }),
      { providers: [mockProvider] },
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("permission: deny");
  });

  it("permission ask auto-approves tool calls when onInterrupt is approve", async () => {
    const graphSpec = spec({
      prompt: "Find the fact.",
      tools: [{ function: "lookup" }],
      permission: "ask",
      output: { to: "answer" },
    });
    graphSpec.runtime = { checkpoint: { enabled: true, backend: "memory" } };
    const compiled = await compileGraph(graphSpec, { providers: [mockProvider] });
    const r = await compiled.run({ input: {}, onInterrupt: "approve", threadId: "perm-ask-test" });
    expect(r.status).toBe("completed");
    const answer = r.state["answer"] as { toolResults: Record<string, unknown> };
    expect(answer.toolResults["lookup"]).toBeDefined();
  });
});

describe("router model mode", () => {
  it("picks a route via the provider and routes accordingly", async () => {
    const scripted = createScriptedProvider("router-mock", () => ({
      output: { route: "feature" },
      stopReason: "done",
    }));
    const routerSpec = {
      metadata: { name: "model-router" },
      state: { channels: { decision: { type: "string" }, done: { type: "string" } } },
      nodes: [
        {
          id: "route",
          type: "router",
          provider: "router-mock",
          with: {
            mode: "model",
            instruction: "Pick a route.",
            routes: {
              bug: { to: "handle" },
              feature: { to: "handle" },
              other: { default: true, to: "handle" },
            },
            output: { to: "decision" },
          },
        },
        { id: "handle", type: "code", with: { fn: "noop", output: { to: "done" } } },
      ],
      edges: [
        { from: "START", to: "route" },
        { from: "route", to: "handle" },
        { from: "handle", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const { registerFunction } = await import("./nodes/code.js");
    registerFunction("noop", () => "handled");

    const compiled = await compileGraph(routerSpec, { providers: [scripted] });
    const events: string[] = [];
    compiled.events.subscribe((e) => { if (e.type === "router.decision") events.push(JSON.stringify(e.data)); });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state["decision"]).toBe("feature");
  });
});
