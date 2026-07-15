import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { registerTool, mockProvider } from "./providers/index.js";
import type { Hook } from "./hooks/types.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

let flakyCalls = 0;

beforeAll(() => {
  registerFunction("setFlag", () => ({ flag: true }));
  registerFunction("flaky", () => {
    flakyCalls++;
    if (flakyCalls === 1) throw new Error("boom");
    return { ok: true };
  });
  registerFunction("emitToken", () => "Bearer abcdefghijklmnopqrstuvwxyz0123456789");
  registerTool({ name: "danger", description: "dangerous", handler: () => ({ ran: true }) });
});

function codeGraph(extra: Partial<GraphSpec> = {}): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "hooks-graph" },
    state: { channels: { flag: { type: "boolean" }, ok: { type: "boolean" } } },
    nodes: [
      { id: "step", type: "function", with: { fn: "setFlag", output: { to: "flag" } } },
    ],
    edges: [
      { from: "START", to: "step" },
      { from: "step", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
    ...extra,
  } as unknown as GraphSpec;
}

describe("hooks — node lifecycle", () => {
  it("node:before veto skips the node", async () => {
    const hook: Hook = { phase: "node:before", handler: () => ({ kind: "veto", reason: "blocked" }) };
    const compiled = await compileGraph(codeGraph(), { hooks: [hook] });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state["flag"]).toBeUndefined();
  });

  it("node:error retry re-runs the node", async () => {
    flakyCalls = 0;
    const spec = codeGraph();
    (spec.nodes[0] as Record<string, unknown>)["with"] = { fn: "flaky", output: { to: "ok" } };
    const hook: Hook = { phase: "node:error", handler: () => ({ kind: "retry" }) };
    const compiled = await compileGraph(spec, { hooks: [hook] });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(flakyCalls).toBe(2);
    expect((r.state["ok"] as { ok: boolean }).ok).toBe(true);
  });

  it("node:before mutate rewrites the rendered input", async () => {
    registerFunction("echoName", (input) => (input as { name?: string }).name ?? "none");
    const spec = codeGraph();
    spec.state = { channels: { name: { type: "string" } } } as GraphSpec["state"];
    (spec.nodes[0] as Record<string, unknown>) = {
      id: "step",
      type: "function",
      input: { name: "original" },
      with: { fn: "echoName", input: { name: "{{ input.name }}" }, output: { to: "name" } },
    };
    const hook: Hook = {
      phase: "node:before",
      handler: () => ({ kind: "mutate", payload: { input: { name: "rewritten" } } }),
    };
    const compiled = await compileGraph(spec, { hooks: [hook] });
    const r = await compiled.run({ input: {} });
    expect(r.state["name"]).toBe("rewritten");
  });
});

describe("hooks — redaction", () => {
  it("state:beforeUpdate redaction guardrail masks secrets", async () => {
    const spec = codeGraph({
      state: { channels: { header: { type: "string" } } },
      runtime: { checkpoint: { enabled: false }, secrets: { redact: {} } },
    } as unknown as Partial<GraphSpec>);
    (spec.nodes[0] as Record<string, unknown>)["with"] = { fn: "emitToken", output: { to: "header" } };
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(String(r.state["header"])).toContain("[REDACTED]");
  });

  it("YAML-bound state:beforeUpdate redact directive masks secrets", async () => {
    const spec = codeGraph({
      state: { channels: { header: { type: "string" } } },
      runtime: {
        checkpoint: { enabled: false },
        hooks: [{ on: "state:beforeUpdate", do: "redact" }],
      },
    } as unknown as Partial<GraphSpec>);
    (spec.nodes[0] as Record<string, unknown>)["with"] = { fn: "emitToken", output: { to: "header" } };
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(String(r.state["header"])).toContain("[REDACTED]");
  });
});

describe("hooks — agent tool gating", () => {
  it("agent:beforeToolCall veto blocks a tool call", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "tool-gate" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [
        { id: "agent", type: "agent", provider: "mock", with: { prompt: "use danger", tools: [{ function: "danger" }], output: { to: "answer" } } },
      ],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const hook: Hook = {
      phase: "agent:beforeToolCall",
      where: { tool: "danger" },
      handler: () => ({ kind: "veto", reason: "not allowed" }),
    };
    const compiled = await compileGraph(spec, { providers: [mockProvider], hooks: [hook] });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("vetoed");
  });
});
