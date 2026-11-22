import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { createLangChainProvider } from "./index.js";
import { assertImportsAllowed, NodePolicyError, type NodePolicy } from "./node-policy.js";
import { registerFunction } from "./nodes/function.js";
import { validateSpec } from "./loader.js";
import { CORE_VERSION } from "./version.js";
import "./nodes/index.js";

const head = { apiVersion: "flowgraph/v1", kind: "Graph" } as const;

function graph(over: Record<string, unknown> = {}): GraphSpec {
  return {
    ...head,
    metadata: { name: "g" },
    nodes: [{ id: "a", type: "function", with: { fn: "fg_strict_noop" } }],
    edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }],
    ...over,
  } as unknown as GraphSpec;
}

registerFunction("fg_strict_noop", () => ({}));

const policy = (over: Partial<NodePolicy>): NodePolicy => ({ blockedTypes: [], allowedTools: [], allowedFunctions: [], reason: "test", ...over });

describe("requireSafeNodeTypes implies blockImports", () => {
  const withImports = { ...graph(), imports: [{ nodes: "./plugin.js" }] };

  it("refuses imports when only requireSafeNodeTypes is set", () => {
    expect(() => assertImportsAllowed(policy({ requireSafeNodeTypes: true }), withImports, "graph")).toThrow(NodePolicyError);
    try {
      assertImportsAllowed(policy({ requireSafeNodeTypes: true }), withImports, "graph");
    } catch (err) {
      expect((err as NodePolicyError).code).toBe("IMPORTS_BLOCKED");
    }
  });

  it("allows imports when neither flag is set", () => {
    expect(() => assertImportsAllowed(policy({}), withImports, "graph")).not.toThrow();
  });

  it("refuses imports inside an inline subgraph", () => {
    const nested = graph({ nodes: [{ id: "s", type: "subgraph", spec: withImports }] });
    expect(() => assertImportsAllowed(policy({ requireSafeNodeTypes: true }), nested, "graph")).toThrow(NodePolicyError);
  });
});

describe("requires.engine", () => {
  it("compiles when the range is met", async () => {
    await expect(compileGraph(graph({ requires: { engine: `>=${CORE_VERSION}` } }))).resolves.toBeDefined();
  });

  it("refuses to validate or compile when the range is not met", async () => {
    const spec = graph({ requires: { engine: ">=999.0.0" } });
    expect(validateSpec(spec)).toContainEqual(
      expect.objectContaining({ severity: "error", code: "ENGINE_VERSION_UNMET", path: "requires.engine", message: expect.stringContaining(`but this is flowgraph ${CORE_VERSION}`) }),
    );
    await expect(compileGraph(spec)).rejects.toThrow(/ENGINE_VERSION_UNMET/);
  });

  it("checks an inline subgraph's own requirement", () => {
    const child = { ...graph({ requires: { engine: ">=999.0.0" } }) };
    const spec = graph({ nodes: [{ id: "s", type: "subgraph", spec: child }], edges: [{ from: "START", to: "s" }, { from: "s", to: "END" }] });
    expect(validateSpec(spec)).toContainEqual(expect.objectContaining({ code: "ENGINE_VERSION_UNMET", path: "nodes.s.spec.requires.engine" }));
  });
});

describe("edges", () => {
  it("reports an edge with both `to` and `branch` instead of dropping the branch", () => {
    const spec = graph({
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END", branch: [{ when: "true", to: "END" }] },
      ],
    });
    expect(validateSpec(spec)).toContainEqual(
      expect.objectContaining({ severity: "error", path: "edges[1]", message: expect.stringContaining('"to" or "branch", not both') }),
    );
  });
});

describe("toolInput is a contract on node-as-tool calls", () => {
  it("rejects arguments that break it before the node runs, and runs once they fit", async () => {
    const ran: unknown[] = [];
    registerFunction("fg_strict_tool", (input) => {
      ran.push(input);
      return { ok: true };
    });
    let turn = 0;
    const calls = [{ q: 5 }, { q: "fits" }];
    const provider = createLangChainProvider(
      {
        invoke: async () => {
          const args = calls[turn++];
          if (!args) return new AIMessage({ content: "done" });
          return new AIMessage({ content: "", tool_calls: [{ name: "f", id: `c${turn}`, args }] });
        },
        bindTools() {
          return this;
        },
      } as never,
      { name: "llm" },
    );
    const spec = graph({
      state: { channels: { out: { type: "object" } } },
      nodes: [
        { id: "a", type: "agent", provider: "llm", with: { prompt: "go", tools: [{ node: "f" }], output: { to: "out" } } },
        {
          id: "f",
          type: "function",
          when: "false",
          toolInput: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false },
          with: { fn: "fg_strict_tool" },
        },
      ],
      edges: [{ from: "START", to: "f" }, { from: "f", to: "a" }, { from: "a", to: "END" }],
    });
    const compiled = await compileGraph(spec, { providers: [provider] });
    const results: Array<{ isError?: boolean; error?: { code?: string; message?: string } }> = [];
    compiled.events.subscribe((e) => {
      if (e.type === "agent.tool.result") results.push((e.data as { result: (typeof results)[number] }).result);
    });
    const res = await compiled.run({ input: {} });
    expect(res.status).toBe("completed");
    const refused = results.filter((r) => r.isError);
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) {
      expect(r.error?.code).toBe("TOOL_INPUT_INVALID");
      expect(r.error?.message).toContain("toolInput");
    }
    expect(results.filter((r) => !r.isError).length).toBeGreaterThan(0);
    expect(ran).toEqual([{ q: "fits" }]);
  });
});
