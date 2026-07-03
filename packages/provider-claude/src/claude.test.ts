import { describe, it, expect } from "vitest";
import { z } from "zod";
import { compileGraph, registerTool, type GraphSpec } from "@veloxdevworks/flowgraph-core";
import { createClaudeProvider, type ClaudeQueryFn } from "./provider.js";

function fakeQuery(messages: unknown[]): ClaudeQueryFn {
  return async function* () {
    for (const m of messages) yield m;
  };
}

const baseSpec = (withBlock: Record<string, unknown>): GraphSpec =>
  ({
    metadata: { name: "claude-graph" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [{ id: "agent", type: "intelligent", provider: "claude", with: withBlock }],
    edges: [
      { from: "START", to: "agent" },
      { from: "agent", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  }) as unknown as GraphSpec;

describe("@veloxdevworks/flowgraph-provider-claude", () => {
  it("returns text from a successful result message", async () => {
    const provider = createClaudeProvider({
      deps: {
        query: fakeQuery([
          { type: "result", subtype: "success", result: "All done.", usage: { input_tokens: 1, output_tokens: 2 } },
        ]),
        createSdkMcpServer: () => ({}),
        tool: () => ({}),
      },
    });

    const compiled = await compileGraph(
      baseSpec({ prompt: "Hi", output: { to: "answer" } }),
      { providers: [provider] },
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state["answer"] as { text: string }).text).toBe("All done.");
  });

  it("maps builtin tools to allowedTools", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const provider = createClaudeProvider({
      deps: {
        query: (req) => {
          capturedOptions = req.options;
          return fakeQuery([{ type: "result", subtype: "success", result: "ok" }])(req);
        },
        createSdkMcpServer: () => ({}),
        tool: () => ({}),
      },
    });

    const compiled = await compileGraph(
      baseSpec({
        prompt: "read file",
        tools: [{ builtin: ["Read", "Grep"] }],
        output: { to: "answer" },
      }),
      { providers: [provider] },
    );
    await compiled.run({ input: {} });
    expect(capturedOptions?.["allowedTools"]).toEqual(expect.arrayContaining(["Read", "Grep"]));
  });

  it("wraps function tools in an SDK MCP server and invokes them", async () => {
    registerTool({ name: "weather", handler: () => ({ tempF: 72 }) });

    const provider = createClaudeProvider({
      deps: {
        query: fakeQuery([{ type: "result", subtype: "success", result: "72F" }]),
        createSdkMcpServer: ({ tools }) => ({ tools }),
        tool: (name, _desc, schema, handler) => ({ name, schema, handler }),
      },
    });

    const compiled = await compileGraph(
      baseSpec({
        prompt: "weather?",
        tools: [{ function: "weather" }],
        output: { to: "answer" },
      }),
      { providers: [provider] },
    );
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
  });

  it("validate warns on unknown builtin tools", () => {
    const provider = createClaudeProvider({
      deps: {
        query: fakeQuery([]),
        createSdkMcpServer: () => ({}),
        tool: () => ({}),
      },
    });
    const diags = provider.validate?.({ tools: [{ builtin: ["NotARealTool"] }] });
    expect(diags?.some((d) => d.message.includes("Unknown Claude builtin"))).toBe(true);
  });

  it("canUseTool routes native tools through governance", async () => {
    let canUseTool: ((name: string, input: Record<string, unknown>) => Promise<unknown>) | undefined;
    const provider = createClaudeProvider({
      deps: {
        query: (req) => {
          canUseTool = req.options["canUseTool"] as typeof canUseTool;
          return fakeQuery([{ type: "result", subtype: "success", result: "ok" }])(req);
        },
        createSdkMcpServer: () => ({}),
        tool: (name, _d, schema, handler) => {
          void z;
          return { name, schema, handler };
        },
      },
    });

    const graphSpec = baseSpec({
      prompt: "edit",
      tools: [{ builtin: ["Edit"] }],
      permission: "deny",
      output: { to: "answer" },
    });
    const compiled = await compileGraph(graphSpec, { providers: [provider] });
    await compiled.run({ input: {} });
    expect(canUseTool).toBeUndefined();
  });
});
