import { describe, it, expect } from "vitest";
import { compileGraph, registerTool, type GraphSpec } from "@veloxdevworks/flowgraph-core";
import { createCursorProvider, type CursorAgentFactory } from "./provider.js";

function fakeAgentFactory(streamEvents: unknown[], waitResult = { status: "finished", result: "Done." }): CursorAgentFactory {
  return async () => ({
    async send() {
      return {
        async *stream() {
          for (const e of streamEvents) yield e;
        },
        async wait() {
          return waitResult;
        },
      };
    },
    async [Symbol.asyncDispose]() {},
  });
}

const baseSpec = (withBlock: Record<string, unknown>): GraphSpec =>
  ({
    metadata: { name: "cursor-graph" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [{ id: "agent", type: "agent", provider: "cursor", with: withBlock }],
    edges: [
      { from: "START", to: "agent" },
      { from: "agent", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  }) as unknown as GraphSpec;

describe("@veloxdevworks/flowgraph-provider-cursor", () => {
  it("returns assistant text from stream + wait", async () => {
    const provider = createCursorProvider({
      apiKey: "test-key",
      agentFactory: fakeAgentFactory([
        { type: "assistant", message: { content: [{ type: "text", text: "Hello from Cursor." }] } },
      ]),
    });

    const compiled = await compileGraph(
      baseSpec({ prompt: "Hi", output: { to: "answer" } }),
      { providers: [provider] },
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state["answer"] as { text: string }).text).toBe("Done.");
  });

  it("invokes custom tools through governance", async () => {
    registerTool({ name: "lookup", handler: () => ({ ok: true }) });
    const provider = createCursorProvider({
      apiKey: "test-key",
      agentFactory: fakeAgentFactory([]),
    });

    const events: string[] = [];
    const compiled = await compileGraph(
      baseSpec({
        prompt: "lookup",
        tools: [{ function: "lookup" }],
        output: { to: "answer" },
      }),
      { providers: [provider], sinks: [(e) => { events.push(e.type); }] },
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(events).toContain("agent.usage");
  });

  it("validate warns when builtin tools combine with permission ask", () => {
    const provider = createCursorProvider({ apiKey: "test-key", agentFactory: fakeAgentFactory([]) });
    const diags = provider.validate?.({
      tools: [{ builtin: ["Read"] }],
      permission: "ask",
    });
    expect(diags?.some((d) => d.severity === "warning" && d.message.includes("cannot gate native builtin"))).toBe(
      true,
    );
  });
});
