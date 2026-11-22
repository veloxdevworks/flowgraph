import { describe, it, expect } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { applyOutput, keepsRawOutput, OUTPUTS_CHANNEL } from "./runtime/apply-output.js";
import { collectNodeWriteChannels } from "./runtime/validate-graph.js";
import { validateSpec } from "./loader.js";

/** Returns `{ count: 1, approved: true }` on the first call and `{ count: 2 }` after that. */
function registerShrinking(name: string): void {
  let calls = 0;
  registerFunction(name, () => {
    calls += 1;
    return calls === 1 ? { count: 1, approved: true } : { count: calls };
  });
}

/** START → a → (a again while outputs.a.count < 2) → END */
function loopSpec(node: Record<string, unknown>, channels: Record<string, unknown> = {}): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "output-replace" },
    state: { channels },
    nodes: [
      node,
      {
        id: "route",
        type: "router",
        with: {
          routes: [ { name: "again", when: "{{ state.round < 2 }}", to: "a" }, { name: "done", default: true, to: "END" } ],
        },
      },
      { id: "count", type: "function", with: { fn: "outputReplaceRound", output: { to: "round", raw: false } }, input: { n: "{{ state.round }}" } },
    ],
    edges: [
      { from: "START", to: "a" },
      { from: "a", to: "count" },
      { from: "count", to: "route" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

registerFunction("outputReplaceRound", (input) => ((input as { n?: number }).n ?? 0) + 1);

describe("state.outputs.<nodeId> is replaced on every run", () => {
  it("drops fields the latest run no longer returns", async () => {
    registerShrinking("outputReplaceLoop");
    const spec = loopSpec(
      { id: "a", type: "function", with: { fn: "outputReplaceLoop" } },
      { round: { type: "number", default: 0 } },
    );
    const r = await (await compileGraph(spec)).run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state["round"]).toBe(2);
    expect((r.state[OUTPUTS_CHANNEL] as Record<string, unknown>)["a"]).toEqual({ count: 2 });
  });

  it("keeps other nodes' entries when one node writes", async () => {
    registerShrinking("outputReplaceSibling");
    registerFunction("outputReplaceStatic", () => ({ fixed: true }));
    const spec: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "output-siblings" },
      nodes: [
        { id: "first", type: "function", with: { fn: "outputReplaceStatic" } },
        { id: "a", type: "function", with: { fn: "outputReplaceSibling" } },
        { id: "b", type: "function", with: { fn: "outputReplaceSibling" } },
      ],
      edges: [
        { from: "START", to: "first" },
        { from: "first", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const r = await (await compileGraph(spec)).run({ input: {} });
    expect(r.state[OUTPUTS_CHANNEL]).toEqual({
      first: { fixed: true },
      a: { count: 1, approved: true },
      b: { count: 2 },
    });
  });

  it("still deep-merges when the graph declares outputs with mergeDeep", async () => {
    registerShrinking("outputReplaceDeclared");
    const spec = loopSpec(
      { id: "a", type: "function", with: { fn: "outputReplaceDeclared" } },
      {
        round: { type: "number", default: 0 },
        outputs: { type: "object", reducer: "mergeDeep", default: {} },
      },
    );
    const r = await (await compileGraph(spec)).run({ input: {} });
    expect((r.state[OUTPUTS_CHANNEL] as Record<string, unknown>)["a"]).toEqual({ count: 2, approved: true });
  });

  it("replaces a subgraph node's result when the subgraph runs again", async () => {
    registerShrinking("outputReplaceChild");
    const child = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child" },
      state: { channels: { res: { type: "any" } } },
      nodes: [{ id: "inner", type: "function", with: { fn: "outputReplaceChild", output: { to: "res", raw: false } } }],
      edges: [
        { from: "START", to: "inner" },
        { from: "inner", to: "END" },
      ],
    };
    const spec = loopSpec(
      { id: "a", type: "subgraph", spec: child, with: { output: { map: { last: "{{ result.res }}" } } } },
      { round: { type: "number", default: 0 }, last: { type: "any" } },
    );
    const r = await (await compileGraph(spec)).run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state[OUTPUTS_CHANNEL] as Record<string, { res?: unknown }>)["a"]?.res).toEqual({ count: 2 });
    expect(r.state["last"]).toEqual({ count: 2 });
  });

  it("replaces whole entries merged back through stateMap.out", async () => {
    registerShrinking("outputReplaceMapped");
    const child = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "child" },
      nodes: [{ id: "inner", type: "function", with: { fn: "outputReplaceMapped" } }],
      edges: [
        { from: "START", to: "inner" },
        { from: "inner", to: "END" },
      ],
    };
    const spec = loopSpec(
      {
        id: "a",
        type: "subgraph",
        spec: child,
        with: { stateMap: { in: { outputs: "outputs" }, out: { outputs: "outputs" } } },
      },
      { round: { type: "number", default: 0 } },
    );
    const r = await (await compileGraph(spec)).run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state[OUTPUTS_CHANNEL] as Record<string, unknown>)["inner"]).toEqual({ count: 2 });
  });
});

describe("raw: false keeps only the projection", () => {
  it("applyOutput skips the outputs slug", () => {
    expect(applyOutput({ to: "shared", raw: false }, { big: "x" }, { nodeId: "step" })).toEqual({ shared: { big: "x" } });
    expect(applyOutput({ map: { n: "{{ result.n }}" }, raw: false }, { n: 3, secret: "s" }, { nodeId: "step" })).toEqual({ n: 3 });
    expect(applyOutput({ to: "shared", raw: true }, 1, { nodeId: "step" })).toEqual({ shared: 1, [OUTPUTS_CHANNEL]: { step: 1 } });
  });

  it("keepsRawOutput is false only for none and raw: false", () => {
    expect(keepsRawOutput(undefined)).toBe(true);
    expect(keepsRawOutput({ to: "x" })).toBe(true);
    expect(keepsRawOutput("none")).toBe(false);
    expect(keepsRawOutput({ to: "x", raw: false })).toBe(false);
  });

  it("does not declare the outputs channel for projection-only nodes", () => {
    const chans = collectNodeWriteChannels({
      id: "emit",
      type: "function",
      with: { fn: "x", output: { to: "shared", raw: false } },
    } as GraphSpec["nodes"][number]);
    expect(chans).toEqual(["shared"]);
    const collect = collectNodeWriteChannels({
      id: "fan",
      type: "map",
      with: { over: "{{ input.items }}", node: { id: "w", type: "function", with: { fn: "x" } }, collect: { to: "all", raw: false } },
    } as unknown as GraphSpec["nodes"][number]);
    expect(collect).toEqual(["all"]);
  });

  it("writes the projection and leaves state.outputs.<nodeId> absent at run time", async () => {
    registerFunction("outputReplaceBig", () => ({ summary: "short", body: "x".repeat(1000) }));
    const spec: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "projection-only" },
      state: { channels: { summary: { type: "string" } } },
      nodes: [
        { id: "big", type: "function", with: { fn: "outputReplaceBig", output: { map: { summary: "{{ result.summary }}" }, raw: false } } },
      ],
      edges: [
        { from: "START", to: "big" },
        { from: "big", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const r = await (await compileGraph(spec)).run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state["summary"]).toBe("short");
    expect(r.state[OUTPUTS_CHANNEL]).toBeUndefined();
  });

  it("applies raw: false to a map node's collect", async () => {
    registerFunction("outputReplaceItem", (input) => Number((input as { n: unknown }).n) * 10);
    const spec: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "collect-projection-only" },
      state: { channels: { items: { type: "array" }, all: { type: "array" }, ns: { type: "array" } } },
      nodes: [
        {
          id: "fan",
          type: "map",
          with: {
            over: "{{ state.items }}",
            as: "n",
            node: { type: "function", with: { fn: "outputReplaceItem" }, input: { n: "{{ n }}" } },
            collect: { to: "all", map: { ns: "{{ result }}" }, raw: false },
          },
        },
      ],
      edges: [
        { from: "START", to: "fan" },
        { from: "fan", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const r = await (await compileGraph(spec)).run({ input: { items: [1, 2] } });
    expect(r.status).toBe("completed");
    expect(r.state["all"]).toEqual([10, 20]);
    expect(r.state["ns"]).toEqual([10, 20]);
    expect(r.state[OUTPUTS_CHANNEL]).toBeUndefined();
  });
});

describe("removed output spellings fail validation", () => {
  const graph = (output: unknown): GraphSpec =>
    ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "removed-spellings" },
      state: { channels: { x: { type: "any" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "outputReplaceStatic", output } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    }) as unknown as GraphSpec;

  it("reports { none: true } and none with to as node config errors", () => {
    registerFunction("outputReplaceStatic", () => ({ fixed: true }));
    const none = validateSpec(graph({ none: true })).filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({ severity: "error", path: "nodes.a.with.output" });
    expect(none[0]!.message).toContain("write output: none");
    const both = validateSpec(graph({ none: true, to: "x" })).filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(both[0]!.message).toContain("cannot be combined with to or map");
    expect(validateSpec(graph({ to: "x", raw: false })).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("refuses to compile a graph that still uses { none: true }", async () => {
    await expect(compileGraph(graph({ none: true }))).rejects.toThrow(/output: none/);
  });
});
