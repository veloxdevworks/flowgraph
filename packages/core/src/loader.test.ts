import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

beforeAll(() => {
  registerFunction("emitA", () => "a");
  registerFunction("emitB", () => "b");
});

function parallelFanOutSpec(reducer: "append" | undefined): GraphSpec {
  return {
    metadata: { name: "parallel-fanout" },
    state: {
      channels: {
        tags: reducer === "append" ? { type: "array", reducer: "append" } : { type: "array" },
      },
    },
    nodes: [
      { id: "branch-a", type: "function", with: { fn: "emitA", output: { to: "tags" } } },
      { id: "branch-b", type: "function", with: { fn: "emitB", output: { to: "tags" } } },
    ],
    edges: [
      { from: "START", to: ["branch-a", "branch-b"] },
      { from: "branch-a", to: "END" },
      { from: "branch-b", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("parallel fan-out reducer behavior", () => {
  it("append preserves both branch writes", async () => {
    const spec = parallelFanOutSpec("append");
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect([...(r.state["tags"] as string[])].sort()).toEqual(["a", "b"]);
  });

  it("lastWrite keeps only one branch write", async () => {
    const spec = parallelFanOutSpec(undefined);
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const tags = r.state["tags"] as string[];
    expect(tags).toHaveLength(1);
    expect(["a", "b"]).toContain(tags[0]);
  });
});

describe("validateSpec graph lint", () => {
  it("warns when append reducer is paired with a non-array channel", () => {
    const diags = validateSpec({
      metadata: { name: "bad-reducer" },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
      state: { channels: { x: { type: "string", reducer: "append" } } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "REDUCER_TYPE_MISMATCH")).toBe(true);
  });

  it("errors on unregistered custom reducer", () => {
    const diags = validateSpec({
      metadata: { name: "missing-custom" },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
      state: { channels: { x: { type: "array", reducer: "custom:notRegisteredHere" } } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "UNREGISTERED_REDUCER" && d.severity === "error")).toBe(true);
  });

  it("warns for nodes not reachable from START", () => {
    const diags = validateSpec({
      metadata: { name: "orphan" },
      nodes: [
        { id: "live", type: "function", with: { fn: "emitA", output: { to: "tags" } } },
        { id: "orphan", type: "function", with: { fn: "emitB", output: { to: "tags" } } },
      ],
      edges: [
        { from: "START", to: "live" },
        { from: "live", to: "END" },
      ],
      state: { channels: { tags: { type: "array", reducer: "append" } } },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "UNREACHABLE_FROM_START" && d.message.includes("orphan"))).toBe(true);
  });

  it("errors when output.to targets an undeclared channel", () => {
    const diags = validateSpec({
      metadata: { name: "undeclared-to" },
      nodes: [
        { id: "shell-1", type: "shell", with: { command: "echo hi", output: { to: "shell" } } },
      ],
      edges: [
        { from: "START", to: "shell-1" },
        { from: "shell-1", to: "END" },
      ],
      state: { channels: {} },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) =>
          d.code === "UNDECLARED_OUTPUT_CHANNEL" &&
          d.severity === "error" &&
          d.message.includes("shell") &&
          d.path === "nodes.shell-1.with.output",
      ),
    ).toBe(true);
  });

  it("errors when output.map keys target undeclared channels", () => {
    const diags = validateSpec({
      metadata: { name: "undeclared-map" },
      nodes: [
        {
          id: "a",
          type: "shell",
          with: {
            command: "echo hi",
            output: { map: { stdout: "{{ result.stdout }}", missing: "{{ result.stderr }}" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
      state: { channels: { stdout: { type: "string" } } },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    const undeclared = diags.filter((d) => d.code === "UNDECLARED_OUTPUT_CHANNEL");
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]!.message).toContain("missing");
  });

  it("errors when subgraph stateMap.out values target undeclared parent channels", () => {
    const diags = validateSpec({
      metadata: { name: "undeclared-statemap" },
      nodes: [
        {
          id: "child",
          type: "subgraph",
          uses: "child-graph",
          with: {
            stateMap: { out: { summary: "testResults" } },
          },
        },
      ],
      edges: [
        { from: "START", to: "child" },
        { from: "child", to: "END" },
      ],
      state: { channels: {} },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) =>
          d.code === "UNDECLARED_OUTPUT_CHANNEL" &&
          d.message.includes("testResults") &&
          d.path === "nodes.child.with.stateMap.out",
      ),
    ).toBe(true);
  });

  it("does not error when output channels are declared", () => {
    const diags = validateSpec({
      metadata: { name: "declared-ok" },
      nodes: [
        { id: "shell-1", type: "shell", with: { command: "echo hi", output: { to: "shell" } } },
        {
          id: "map-1",
          type: "map",
          with: {
            over: "{{ state.items }}",
            node: { type: "shell", with: { command: "echo" } },
            collect: { to: "results" },
          },
        },
      ],
      edges: [
        { from: "START", to: "shell-1" },
        { from: "shell-1", to: "map-1" },
        { from: "map-1", to: "END" },
      ],
      state: {
        channels: {
          shell: { type: "object" },
          items: { type: "array" },
          results: { type: "array", reducer: "append" },
        },
      },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "UNDECLARED_OUTPUT_CHANNEL")).toBe(false);
  });
});

describe("normalizeNodeTypeAliases", () => {
  it("rewrites deprecated code/intelligent types and hook phases", async () => {
    const { normalizeNodeTypeAliases } = await import("./loader.js");
    const parsed = normalizeNodeTypeAliases({
      nodes: [
        { id: "a", type: "code", with: { fn: "x" } },
        { id: "b", type: "intelligent", with: { prompt: "hi" } },
        {
          id: "m",
          type: "map",
          with: { items: "{{ state.xs }}", node: { type: "code", with: { fn: "y" } } },
        },
      ],
      runtime: {
        hooks: [{ on: "intelligent:beforeToolCall", do: "interrupt" }],
      },
    }) as {
      nodes: Array<{ type: string; with?: { node?: { type: string } } }>;
      runtime: { hooks: Array<{ on: string }> };
    };
    expect(parsed.nodes[0]!.type).toBe("function");
    expect(parsed.nodes[1]!.type).toBe("agent");
    expect(parsed.nodes[2]!.with?.node?.type).toBe("function");
    expect(parsed.runtime.hooks[0]!.on).toBe("agent:beforeToolCall");
  });
});

describe("validateSpec node config", () => {
  it("errors on unregistered node type", () => {
    const diags = validateSpec({
      metadata: { name: "unknown-type" },
      nodes: [{ id: "x", type: "not-a-real-type", with: {} }],
      edges: [
        { from: "START", to: "x" },
        { from: "x", to: "END" },
      ],
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) =>
          d.code === "UNKNOWN_NODE_TYPE" &&
          d.severity === "error" &&
          d.path === "nodes.x.type",
      ),
    ).toBe(true);
  });

  it("errors when hitl with is missing required message", () => {
    const diags = validateSpec({
      metadata: { name: "bad-hitl" },
      nodes: [{ id: "gate", type: "hitl", with: { mode: "approve" } }],
      edges: [
        { from: "START", to: "gate" },
        { from: "gate", to: "END" },
      ],
    } as unknown as GraphSpec);
    const cfg = diags.filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(cfg.length).toBeGreaterThan(0);
    expect(cfg.some((d) => d.path?.includes("nodes.gate.with") && d.message.includes("message"))).toBe(
      true,
    );
  });

  it("does not emit NODE_CONFIG_ERROR for a valid hitl node", () => {
    const diags = validateSpec({
      metadata: { name: "ok-hitl" },
      nodes: [{ id: "gate", type: "hitl", with: { mode: "approve", message: "OK?" } }],
      edges: [
        { from: "START", to: "gate" },
        { from: "gate", to: "END" },
      ],
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "NODE_CONFIG_ERROR")).toBe(false);
    expect(diags.some((d) => d.code === "UNKNOWN_NODE_TYPE")).toBe(false);
  });

  it("describes the expected output mapping shape when output is invalid", () => {
    const diags = validateSpec({
      metadata: { name: "bad-output" },
      nodes: [
        {
          id: "fetch",
          type: "http",
          with: { method: "GET", url: "https://example.com", output: "httpResult" },
        },
      ],
      edges: [
        { from: "START", to: "fetch" },
        { from: "fetch", to: "END" },
      ],
    } as unknown as GraphSpec);
    const cfg = diags.filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(cfg.length).toBeGreaterThan(0);
    expect(
      cfg.some(
        (d) => d.path === "nodes.fetch.with.output" && /expected \{ to:/.test(d.message),
      ),
    ).toBe(true);
  });
});
