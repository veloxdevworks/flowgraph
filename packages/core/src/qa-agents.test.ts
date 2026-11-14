import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerTool } from "./providers/registry.js";
import { createLangChainProvider, type ChatModelLike } from "./providers/langchain/provider.js";
import { createScriptedProvider } from "./providers/index.js";
import type { McpHub } from "./mcp/types.js";

const schema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
};
function graph(nodes: unknown[], runtime = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "agent-qa" },
    nodes,
    edges: [
      { from: "START", to: "ask" },
      { from: "ask", to: "END" },
    ],
    runtime,
  });
}
const agent = (extra = {}) => ({
  id: "ask",
  type: "agent",
  provider: "qa-contract",
  with: { prompt: "answer", ...extra },
});
function model(responses: AIMessage[], structured = { name: "valid" }): ChatModelLike {
  let index = 0;
  return {
    invoke: vi.fn(async () => responses[Math.min(index++, responses.length - 1)]!),
    bindTools() {
      return this;
    },
    withStructuredOutput: vi.fn(() => ({ invoke: async () => structured })),
  };
}

describe("PLAT-298: structured output and explicit tools", () => {
  it("does not add hidden tools", async () => {
    let tools: string[] = [];
    const provider = createScriptedProvider("qa-contract", (req) => {
      tools = req.tools.map((t) => t.name);
      return { output: {}, stopReason: "done" };
    });
    expect(
      (await (await compileGraph(graph([agent()]), { providers: [provider] })).run()).status,
    ).toBe("completed");
    expect(tools).toEqual([]);
  });
  it("allows explicit report_issue opt-in", async () => {
    const provider = createScriptedProvider("qa-contract", async (_req, ctx) => ({
      output: await ctx.invokeTool("report_issue", { message: "known gap" }),
      stopReason: "done",
    }));
    const r = await (
      await compileGraph(graph([agent({ tools: [{ function: "report_issue" }] })]), {
        providers: [provider],
      })
    ).run();
    expect(r.status).toBe("completed");
    expect(r.issues?.[0]?.message).toBe("known gap");
  });
  it.each([false, true])("uses constrained final output with tools=%s", async (tools) => {
    registerTool({ name: "qa_contract_tool", handler: () => "fact" });
    const fake = model([new AIMessage({ content: "not JSON" })]);
    const provider = createLangChainProvider(fake, { name: "qa-contract" });
    const r = await (
      await compileGraph(
        graph([agent({ schema, ...(tools ? { tools: [{ function: "qa_contract_tool" }] } : {}) })]),
        { providers: [provider] },
      )
    ).run();
    expect(r.status).toBe("completed");
    expect(r.state.outputs).toMatchObject({ ask: { name: "valid" } });
    expect(fake.withStructuredOutput).toHaveBeenCalled();
  });
  it("rejects a custom provider output that violates schema", async () => {
    const provider = createScriptedProvider("qa-contract", () => ({
      output: { wrong: "shape" },
      stopReason: "done",
    }));
    const r = await (
      await compileGraph(graph([agent({ schema })]), { providers: [provider] })
    ).run();
    expect(r.status).toBe("error");
    expect(r.error?.message).toMatch(/ask.*schema|schema.*ask/i);
  });
  it.each([{ name: "valid", extra: true }, { name: 12 }])(
    "enforces required types and closed objects",
    async (output) => {
      const provider = createScriptedProvider("qa-contract", () => ({
        output,
        stopReason: "done",
      }));
      const r = await (
        await compileGraph(graph([agent({ schema })]), { providers: [provider] })
      ).run();
      expect(r.status).toBe("error");
      expect(r.error).toMatchObject({ code: "AGENT_OUTPUT_INVALID", retryable: false });
    },
  );
  it("validates nested arrays and enums without changing provider data", async () => {
    const output = { entries: [{ status: "unknown" }] };
    const nested = {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: { status: { enum: ["ok", "failed"] } },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
      required: ["entries"],
      additionalProperties: false,
    };
    const provider = createScriptedProvider("qa-contract", () => ({ output, stopReason: "done" }));
    const r = await (
      await compileGraph(graph([agent({ schema: nested })]), { providers: [provider] })
    ).run();
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("/entries/0/status");
    expect(output).toEqual({ entries: [{ status: "unknown" }] });
  });
});

describe("PLAT-299/321/333/347: provider failures", () => {
  it("generates a closed router schema", async () => {
    const provider = createScriptedProvider("qa-contract", (req) => {
      expect(req.schema?.additionalProperties).toBe(false);
      return { output: { route: "done" }, stopReason: "done" };
    });
    const r = await (
      await compileGraph(
        graph([
          {
            id: "ask",
            type: "router",
            provider: provider.name,
            with: { mode: "model", routes: { done: { to: "END" } } },
          },
        ]),
        { providers: [provider] },
      )
    ).run();
    expect(r.status).toBe("completed");
  });
  it("sends a recoverable tool error back to the model", async () => {
    registerTool({
      name: "qa_throw",
      handler: () => {
        throw new Error("recoverable failure");
      },
    });
    let calls = 0;
    const fake: ChatModelLike = {
      bindTools() {
        return this;
      },
      async invoke(messages) {
        if (++calls === 1)
          return new AIMessage({
            content: "",
            tool_calls: [{ name: "qa_throw", args: {}, id: "one" }],
          });
        expect(JSON.stringify(messages)).toContain("recoverable failure");
        return new AIMessage({ content: "recovered" });
      },
    };
    const r = await (
      await compileGraph(graph([agent({ tools: [{ function: "qa_throw" }] })]), {
        providers: [createLangChainProvider(fake, { name: "qa-contract" })],
      })
    ).run();
    expect(r.status).toBe("completed");
    expect(calls).toBe(2);
  });
  it("keeps explicit permission denial fatal", async () => {
    registerTool({
      name: "qa_denied",
      handler: () => {
        throw new Error("must not run");
      },
    });
    const fake = model([
      new AIMessage({ content: "", tool_calls: [{ name: "qa_denied", args: {}, id: "one" }] }),
    ]);
    const r = await (
      await compileGraph(
        graph([agent({ tools: [{ function: "qa_denied" }], permission: "deny" })]),
        { providers: [createLangChainProvider(fake, { name: "qa-contract" })] },
      )
    ).run();
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("permission: deny");
    expect(fake.invoke).toHaveBeenCalledTimes(1);
  });
  it("makes step exhaustion an attributed error", async () => {
    registerTool({ name: "qa_spin", handler: () => "again" });
    const fake = model([
      new AIMessage({ content: "", tool_calls: [{ name: "qa_spin", args: {}, id: "one" }] }),
    ]);
    const r = await (
      await compileGraph(graph([agent({ tools: [{ function: "qa_spin" }], maxSteps: 1 })]), {
        providers: [createLangChainProvider(fake, { name: "qa-contract" })],
      })
    ).run();
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "AGENT_MAX_STEPS", retryable: false });
  });
  it("fails deterministic MCP calls returning isError", async () => {
    const hub: McpHub = {
      listTools: async () => [],
      readResource: async () => ({}),
      close: async () => {},
      callTool: async () => ({ isError: true, content: [{ type: "text", text: "failed" }] }),
    };
    const r = await (
      await compileGraph(
        graph([{ id: "ask", type: "mcp", with: { server: "fake", tool: "fail" } }]),
        { mcp: hub },
      )
    ).run();
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "MCP_TOOL_ERROR" });
  });
});
