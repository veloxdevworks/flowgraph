import { describe, it, expect, beforeAll } from "vitest";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { createScriptedProvider } from "./providers/index.js";
import { applyOutput, isOutputNone, OUTPUTS_CHANNEL } from "./runtime/apply-output.js";
import {
  collectNodeWriteChannels,
  ensureDeclaredOutputChannels,
  OUTPUTS_CHANNEL_DEF,
} from "./runtime/validate-graph.js";

beforeAll(() => {
  registerFunction("echo", (input) => input);
  registerFunction("emitObj", () => ({ text: "hello", n: 42 }));
  registerFunction("double", (input) => {
    const n = (input as { n?: number }).n ?? 0;
    return n * 2;
  });
});

function baseSpec(nodes: GraphSpec["nodes"], channels: Record<string, unknown> = {}): GraphSpec {
  const edges =
    nodes.length === 0
      ? []
      : [
          { from: "START", to: nodes[0]!.id },
          ...nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1]!.id })),
          { from: nodes[nodes.length - 1]!.id, to: "END" },
        ];
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "output-default" },
    state: { channels },
    nodes,
    edges,
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("applyOutput helper", () => {
  it("isOutputNone recognizes both forms", () => {
    expect(isOutputNone("none")).toBe(true);
    expect(isOutputNone({ none: true })).toBe(true);
    expect(isOutputNone({ to: "x" })).toBe(false);
    expect(isOutputNone(undefined)).toBe(false);
  });

  it("defaults to state.outputs.<nodeId>", () => {
    expect(applyOutput(undefined, { ok: 1 }, { nodeId: "step" })).toEqual({
      [OUTPUTS_CHANNEL]: { step: { ok: 1 } },
    });
  });

  it("opts out with none", () => {
    expect(applyOutput("none", { ok: 1 }, { nodeId: "step" })).toEqual({});
    expect(applyOutput({ none: true }, { ok: 1 }, { nodeId: "step" })).toEqual({});
  });

  it("applies to + map additively with the outputs slug", () => {
    const update = applyOutput(
      { to: "shared", map: { n: "{{ result.n }}" } },
      { text: "hi", n: 7 },
      { nodeId: "step" },
    );
    expect(update[OUTPUTS_CHANNEL]).toEqual({ step: { text: "hi", n: 7 } });
    expect(update["shared"]).toEqual({ text: "hi", n: 7 });
    expect(update["n"]).toBe(7);
  });
});

describe("node output defaults", () => {
  it("writes state.outputs.<nodeId> when output is omitted", async () => {
    const spec = baseSpec([{ id: "alpha", type: "function", with: { fn: "emitObj" } }]);
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state[OUTPUTS_CHANNEL] as Record<string, unknown>)["alpha"]).toEqual({
      text: "hello",
      n: 42,
    });
    expect(r.state["result"]).toBeUndefined();
    expect(r.state["alpha"]).toBeUndefined();
  });

  it("writes nothing when output is none", async () => {
    const spec = baseSpec([
      { id: "side-effect", type: "function", with: { fn: "emitObj", output: "none" } },
    ]);
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state[OUTPUTS_CHANNEL]).toBeUndefined();
    expect(r.state["side-effect"]).toBeUndefined();
    expect(r.state["result"]).toBeUndefined();
  });

  it("applies to + map together and still writes the outputs slug", async () => {
    const spec = baseSpec(
      [
        {
          id: "emit",
          type: "function",
          with: {
            fn: "emitObj",
            output: {
              to: "shared",
              map: { label: "{{ result.text }}", count: "{{ result.n }}" },
            },
          },
        },
      ],
      {
        shared: { type: "object" },
        label: { type: "string" },
        count: { type: "number" },
      },
    );
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect((r.state[OUTPUTS_CHANNEL] as Record<string, unknown>)["emit"]).toEqual({
      text: "hello",
      n: 42,
    });
    expect(r.state["shared"]).toEqual({ text: "hello", n: 42 });
    expect(r.state["label"]).toBe("hello");
    expect(r.state["count"]).toBe(42);
  });

  it("two output-less agent nodes do not collide on a shared result channel", async () => {
    const scripted = createScriptedProvider("scripted-out", (req) => ({
      output: { text: String(req.prompt) },
      stopReason: "done",
    }));
    const spec = baseSpec([
      { id: "first", type: "agent", provider: "scripted-out", with: { prompt: "A" } },
      { id: "second", type: "agent", provider: "scripted-out", with: { prompt: "B" } },
    ]);
    const compiled = await compileGraph(spec, { providers: [scripted] });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const outputs = r.state[OUTPUTS_CHANNEL] as Record<string, unknown>;
    expect(outputs["first"]).toEqual({ text: "A" });
    expect(outputs["second"]).toEqual({ text: "B" });
    expect(r.state["result"]).toBeUndefined();
  });

  it("map collect still unwraps inner-node slug writes into the collected array", async () => {
    const spec = baseSpec(
      [
        {
          id: "map-double",
          type: "map",
          with: {
            over: "{{ state.numbers }}",
            as: "n",
            concurrency: 2,
            // Inner node omits output → writes state.outputs.<innerId>; unwrap peels it.
            node: { type: "function", with: { fn: "double", input: { n: "{{ item.n }}" } } },
            collect: { to: "doubled" },
          },
        },
      ],
      {
        numbers: { type: "array" },
        doubled: { type: "array" },
      },
    );
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { numbers: [1, 2, 3] } });
    expect(r.status).toBe("completed");
    expect(r.state["doubled"]).toEqual([2, 4, 6]);
    // map node also writes its own outputs slug (additive with collect.to)
    expect((r.state[OUTPUTS_CHANNEL] as Record<string, unknown>)["map-double"]).toEqual([2, 4, 6]);
  });
});

describe("collectNodeWriteChannels — outputs auto-declare", () => {
  it("includes outputs unless output is none", () => {
    const withSlug = collectNodeWriteChannels({
      id: "alpha",
      type: "function",
      with: { fn: "x" },
    });
    expect(withSlug).toContain(OUTPUTS_CHANNEL);

    const optedOut = collectNodeWriteChannels({
      id: "alpha",
      type: "function",
      with: { fn: "x", output: "none" },
    });
    expect(optedOut).not.toContain(OUTPUTS_CHANNEL);
  });

  it("includes to + map channels and the outputs channel", () => {
    const chans = collectNodeWriteChannels({
      id: "emit",
      type: "function",
      with: { fn: "x", output: { to: "shared", map: { a: "{{ result.a }}" } } },
    });
    expect(chans.sort()).toEqual(["a", OUTPUTS_CHANNEL, "shared"].sort());
  });

  it("ensureDeclaredOutputChannels auto-declares outputs with mergeDeep", () => {
    const spec = baseSpec([{ id: "alpha", type: "function", with: { fn: "echo" } }]);
    const ensured = ensureDeclaredOutputChannels(spec);
    expect(ensured.state?.channels?.[OUTPUTS_CHANNEL]).toEqual(OUTPUTS_CHANNEL_DEF);
  });
});
