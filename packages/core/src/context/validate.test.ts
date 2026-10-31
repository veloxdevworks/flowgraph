import { describe, it, expect } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { validateSpec } from "../loader.js";

function graph(agentWith: Record<string, unknown>, extra: Partial<Record<string, unknown>> = {}): GraphSpec {
  return {
    metadata: { name: "ctx-lint" },
    state: { channels: { chat: { type: "messages" }, notes: { type: "array" }, out: { type: "object" } } },
    nodes: [{ id: "a", type: "agent", provider: "mock", with: { prompt: "hi", output: { to: "out" }, ...agentWith } }],
    edges: [
      { from: "START", to: "a" },
      { from: "a", to: "END" },
    ],
    ...extra,
  } as unknown as GraphSpec;
}

const ctxDiags = (spec: GraphSpec) => validateSpec(spec).filter((d) => d.code.startsWith("CONTEXT_"));
const codes = (spec: GraphSpec) => ctxDiags(spec).map((d) => `${d.severity}:${d.code}`);

describe("context lint", () => {
  it("accepts a sound config", () => {
    expect(codes(graph({ context: { history: "chat", maxTokens: 8000, strategy: "summarize", summarize: { maxTokens: 300 } } }))).toEqual([]);
  });

  it("requires the history channel to be a declared messages channel", () => {
    expect(codes(graph({ context: { history: "missing" } }))).toEqual(["error:CONTEXT_HISTORY_CHANNEL"]);
    const d = ctxDiags(graph({ context: { history: "notes" } }));
    expect(d.map((x) => x.code)).toEqual(["CONTEXT_HISTORY_CHANNEL"]);
    expect(d[0]!.message).toMatch(/must be a type: messages channel/);
    expect(d[0]!.path).toBe("nodes.a.with.context.history");
  });

  it("warns about a large issues cap and summarizer settings that extract ignores", () => {
    expect(codes(graph({ context: { maxTokens: 1000, issuesMaxTokens: 600 } }))).toEqual(["warning:CONTEXT_BUDGET_TOO_SMALL"]);
    expect(codes(graph({ context: { maxTokens: 8000, issuesMaxTokens: 600 } }))).toEqual([]);
    expect(codes(graph({ context: { strategy: "summarize", summarize: { mode: "extract", model: "mini" } } }))).toEqual(["warning:CONTEXT_OPTION_UNUSED"]);
    expect(codes(graph({ context: { strategy: "summarize", summarize: { mode: "extract" } } }))).toEqual([]);
  });

  it("flags budgets that leave no room", () => {
    expect(codes(graph({ maxTokens: 4000, context: { maxTokens: 3000 } }))).toEqual(["error:CONTEXT_BUDGET_TOO_SMALL"]);
    expect(codes(graph({ context: { maxTokens: 1000, strategy: "summarize", summarize: { maxTokens: 600 } } }))).toEqual(["error:CONTEXT_BUDGET_TOO_SMALL"]);
    expect(codes(graph({ context: { maxTokens: 1000, toolResultMaxTokens: 1000 } }))).toEqual(["warning:CONTEXT_BUDGET_TOO_SMALL"]);
    const rt = ctxDiags(graph({}, { runtime: { context: { maxTokens: 100, reserveTokens: 100 } } }));
    expect(rt.map((d) => `${d.severity}:${d.code}:${d.path}`)).toEqual(["error:CONTEXT_BUDGET_TOO_SMALL:runtime.context.maxTokens"]);
  });

  it("warns about options the strategy ignores", () => {
    expect(codes(graph({ context: { strategy: "trim", lastN: 5, summarize: { maxTokens: 100 } } }))).toEqual([
      "warning:CONTEXT_OPTION_UNUSED",
      "warning:CONTEXT_OPTION_UNUSED",
    ]);
    expect(codes(graph({ context: { record: "all" } }))).toEqual(["warning:CONTEXT_OPTION_UNUSED"]);
    expect(codes(graph({ context: { strategy: "last", lastN: 5 } }))).toEqual([]);
  });

  it("warns when memory recall wants more than half the budget", () => {
    const memory = { maxTokens: 3000, recall: [{ id: "n", scopes: ["graph"], prefix: "n/" }] };
    const spec = graph({ memory, context: { maxTokens: 4000 } }, { runtime: { memory: { backend: "memory" } } });
    const d = ctxDiags(spec);
    expect(d.map((x) => `${x.severity}:${x.code}`)).toEqual(["warning:CONTEXT_MEMORY_OVER_BUDGET"]);
    expect(d[0]!.message).toMatch(/limited to 2000 tokens/);
    // also through runtime.context defaults
    expect(codes(graph({ memory }, { runtime: { memory: { backend: "memory" }, context: { maxTokens: 4000 } } }))).toEqual(["warning:CONTEXT_MEMORY_OVER_BUDGET"]);
  });

  it("warns about history inside map and the deepagents hub", () => {
    const spec = {
      metadata: { name: "ctx-map-lint" },
      state: { channels: { chat: { type: "messages" }, xs: { type: "array" }, out: { type: "array" } } },
      nodes: [
        {
          id: "fan",
          type: "map",
          with: { over: "{{ state.xs }}", as: "x", node: { type: "agent", provider: "mock", with: { prompt: "{{ item.x }}", context: { history: "chat" } } }, collect: { to: "out" } },
        },
      ],
      edges: [
        { from: "START", to: "fan" },
        { from: "fan", to: "END" },
      ],
    } as unknown as GraphSpec;
    expect(codes(spec)).toEqual(["warning:CONTEXT_HISTORY_IN_MAP"]);
    expect(codes(graph({ hub: "deepagents", context: { maxTokens: 8000 } }))).toEqual(["warning:CONTEXT_HUB_UNSUPPORTED"]);
  });

  it("rejects unknown context keys and strategies at schema level", () => {
    const bad = validateSpec(graph({ context: { strategy: "fifo" } }));
    expect(bad.some((d) => d.severity === "error" && /none \| last \| trim \| summarize/.test(d.message))).toBe(true);
  });
});
