import { describe, it, expect } from "vitest";
import { compileGraph, registerTool, type GraphSpec } from "@flowgraph/core";
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

describe("@flowgraph/provider-cursor", () => {
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

  it("validate checks the configured key, not a hardcoded variable name", () => {
    const missing = (p: ReturnType<typeof createCursorProvider>) =>
      (p.validate?.({}) ?? []).filter((d) => d.message.startsWith("Missing ")).map((d) => d.message);
    const saved = { ...process.env };
    try {
      delete process.env["CURSOR_API_KEY"];
      delete process.env["FGQA_CURSOR_KEY"];
      expect(missing(createCursorProvider({ apiKey: "configured-key", agentFactory: fakeAgentFactory([]) }))).toEqual([]);
      expect(missing(createCursorProvider({ apiKeyEnv: "FGQA_CURSOR_KEY", agentFactory: fakeAgentFactory([]) }))).toEqual([
        "Missing FGQA_CURSOR_KEY. Set it before running Cursor provider nodes.",
      ]);
      process.env["FGQA_CURSOR_KEY"] = "set";
      expect(missing(createCursorProvider({ apiKeyEnv: "FGQA_CURSOR_KEY", agentFactory: fakeAgentFactory([]) }))).toEqual([]);
    } finally {
      process.env = saved;
    }
  });

  it("trusts the local workspace by default (no TTY after handoff)", async () => {
    let created: Record<string, unknown> | undefined;
    const inner = fakeAgentFactory([]);
    const provider = createCursorProvider({
      apiKey: "test-key",
      agentFactory: async (opts) => {
        created = opts;
        return inner(opts);
      },
    });

    const compiled = await compileGraph(
      baseSpec({ prompt: "Hi", output: { to: "answer" } }),
      { providers: [provider] },
    );
    await compiled.run({ input: {} });
    const local = created?.["local"] as { trust?: boolean } | undefined;
    expect(local?.trust).toBe(true);
  });
});
