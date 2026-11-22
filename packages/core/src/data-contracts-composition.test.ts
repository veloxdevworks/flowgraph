import { describe, it, expect, beforeAll } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { validateSpec } from "./loader.js";

beforeAll(() => {
  registerFunction("compositionEcho", (input) => input);
  registerFunction("compositionShout", (input) => `${(input as { text: string }).text}!`);
});

const graph = (parts: Record<string, unknown>): GraphSpec =>
  ({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "composition" },
    runtime: { checkpoint: { enabled: false } },
    ...parts,
  }) as unknown as GraphSpec;

const line = (...ids: string[]) =>
  ["START", ...ids, "END"].slice(0, -1).map((from, i) => ({ from, to: [...ids, "END"][i] }));

const mapGraph = (withBlock: Record<string, unknown>, channels: Record<string, unknown> = {}) =>
  graph({
    state: { channels: { items: { type: "array" }, results: { type: "array" }, ...channels } },
    nodes: [{ id: "fan", type: "map", with: { over: "{{ state.items }}", collect: { to: "results" }, ...withBlock } }],
    edges: line("fan"),
  });

const errorMessages = (spec: GraphSpec) =>
  validateSpec(spec)
    .filter((d) => d.severity === "error")
    .map((d) => d.message)
    .join(" | ");

const codes = (spec: GraphSpec, severity?: "error" | "warning") =>
  validateSpec(spec)
    .filter((d) => !severity || d.severity === severity)
    .map((d) => d.code);

describe("map binding", () => {
  it("binds the item directly under `as` and exposes the index", async () => {
    const spec = mapGraph({
      as: "task",
      node: { type: "function", input: { who: "{{ task.name }}", at: "{{ index }}" }, with: { fn: "compositionEcho" } },
    });
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { items: [{ name: "a" }, { name: "b" }] } });
    expect(r.status).toBe("completed");
    expect(r.state["results"]).toEqual([
      { who: "a", at: 0 },
      { who: "b", at: 1 },
    ]);
  });

  it("binds the item as `item` by default", async () => {
    const spec = mapGraph({ node: { type: "function", input: { text: "{{ item }}" }, with: { fn: "compositionShout" } } });
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { items: ["x", "y"] } });
    expect(r.state["results"]).toEqual(["x!", "y!"]);
  });

  it("skips an item whose inner `when` is false", async () => {
    const spec = mapGraph({
      as: "n",
      node: { type: "function", when: "{{ n > 1 }}", input: { text: "{{ n }}" }, with: { fn: "compositionShout" } },
    });
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { items: [1, 2, 3] } });
    expect(r.status).toBe("completed");
    expect(r.state["results"]).toEqual(["2!", "3!"]);
  });

  it("rejects `as` names that templates already bind, and a map-level output", () => {
    const body = { type: "function", with: { fn: "compositionEcho" } };
    const messages = (withBlock: Record<string, unknown>) => errorMessages(mapGraph({ node: body, ...withBlock }));
    expect(messages({ as: "state" })).toContain("as cannot be");
    expect(messages({ as: "index" })).toContain("as cannot be");
    expect(messages({ as: "not-an-identifier" })).toContain("as must be an identifier");
    expect(messages({ output: { to: "results" } })).toContain("map with.output is not supported");
    expect(messages({ as: "task" })).toBe("");
  });

  it("reports the removed {{ item.<as> }} form", () => {
    const spec = mapGraph({
      as: "task",
      node: { type: "function", input: { who: "{{ item.task }}" }, with: { fn: "compositionEcho" } },
    });
    expect(codes(spec)).toContain("MAP_ITEM_REF_REMOVED");
    const fixed = mapGraph({
      as: "task",
      node: { type: "function", input: { who: "{{ task }}" }, with: { fn: "compositionEcho" } },
    });
    expect(codes(fixed)).not.toContain("MAP_ITEM_REF_REMOVED");
  });
});

const child = (extra: Record<string, unknown> = {}) => ({
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "child" },
  inputs: [{ key: "text", type: "string", required: true }],
  outputs: [{ key: "shout", type: "string", schema: { type: "string", minLength: 2 } }],
  state: { channels: { shout: { type: "string" } } },
  nodes: [{ id: "s", type: "function", input: { text: "{{ state.text }}" }, with: { fn: "compositionShout", output: { to: "shout" } } }],
  edges: line("s"),
  ...extra,
});

const parent = (nodeParts: Record<string, unknown>, spec: Record<string, unknown> = child()) =>
  graph({
    state: { channels: { word: { type: "string" }, said: { type: "string" }, spare: { type: "string" } } },
    nodes: [{ id: "call", type: "subgraph", spec, ...nodeParts }],
    edges: line("call"),
  });

describe("subgraph call boundary", () => {
  it("passes declared inputs in and returns declared outputs", async () => {
    const spec = parent({ input: { text: "{{ state.word }}" }, with: { stateMap: { out: { said: "shout" } } } });
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { word: "hi" } });
    expect(r.status).toBe("completed");
    expect(r.state["said"]).toBe("hi!");
  });

  it("rejects an input the child does not declare", async () => {
    const spec = parent({ input: { text: "x", extra: 1 } });
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "INPUT_INVALID" });
    expect(r.error?.message).toContain('unknown input "extra"');
  });

  it("rejects a missing required input and a wrong-type input", async () => {
    const missing = await (await compileGraph(parent({ input: {} }), {})).run({ input: {} });
    expect(missing.status).toBe("error");
    expect(missing.error?.message).toContain("missing required input");

    const wrong = await (await compileGraph(parent({ input: { text: 5 } }), {})).run({ input: {} });
    expect(wrong.status).toBe("error");
    expect(wrong.error?.message).toContain("expected a string");
  });

  it("fails with SUBGRAPH_OUTPUT_INVALID when a declared output breaks its contract", async () => {
    const spec = parent({ input: { text: "x" } }, child({ state: { channels: { shout: { type: "any" } } }, nodes: [{ id: "s", type: "function", input: { text: "{{ state.text }}" }, with: { fn: "compositionEcho", output: { to: "shout" } } }] }));
    const r = await (await compileGraph(spec, {})).run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "SUBGRAPH_OUTPUT_INVALID" });
    expect(r.error?.message).toContain('output "shout"');
  });

  it("fails with SUBGRAPH_OUTPUT_INVALID when a required output was never produced", async () => {
    const silent = child({ nodes: [{ id: "s", type: "function", input: { text: "x" }, with: { fn: "compositionShout", output: "none" } }] });
    const r = await (await compileGraph(parent({ input: { text: "x" } }, silent), {})).run({ input: {} });
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "SUBGRAPH_OUTPUT_INVALID" });
    expect(r.error?.message).toContain('output "shout" was not produced');
  });

  it("returns only the declared outputs to the parent", async () => {
    const wide = child({
      state: { channels: { shout: { type: "string" }, spare: { type: "string" } } },
      nodes: [
        { id: "s", type: "function", input: { text: "{{ state.text }}" }, with: { fn: "compositionShout", output: { to: "shout" } } },
        { id: "t", type: "function", input: { text: "side" }, with: { fn: "compositionShout", output: { to: "spare" } } },
      ],
      edges: line("s", "t"),
    });
    const compiled = await compileGraph(parent({ input: { text: "hi" } }, wide), {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(r.state["shout"]).toBeUndefined();
    expect(r.state["spare"] ?? null).toBeNull();
  });

  it("rejects stateMap.out together with output", () => {
    const spec = parent({ input: { text: "x" }, with: { stateMap: { out: { said: "shout" } }, output: { to: "said" } } });
    expect(errorMessages(spec)).toContain("stateMap.out");
    expect(codes(spec, "error")).toContain("NODE_CONFIG_ERROR");
  });

  it("reports what static validation can see", () => {
    expect(codes(parent({ input: { text: "x", extra: 1 } }), "error")).toContain("SUBGRAPH_INPUT_UNKNOWN");
    expect(codes(parent({ input: {} }), "error")).toContain("SUBGRAPH_INPUT_MISSING");
    expect(codes(parent({ input: { text: "x" }, with: { stateMap: { out: { said: "spare" } } } }), "error")).toContain("SUBGRAPH_OUTPUT_UNKNOWN");
    expect(codes(parent({ input: { text: "x" }, with: { stateMap: { out: { said: "shout" } } } }), "error")).toEqual([]);
  });
});

describe("output declarations and placed input", () => {
  it("reports an output key declared twice and one that names no channel", () => {
    const dup = graph({
      state: { channels: { a: { type: "string" } } },
      outputs: [{ key: "a" }, { key: "a" }],
      nodes: [{ id: "n", type: "function", input: {}, with: { fn: "compositionEcho" } }],
      edges: line("n"),
    });
    expect(codes(dup)).toContain("DUPLICATE_OUTPUT_KEY");
    const unknown = graph({
      state: { channels: { a: { type: "string" } } },
      outputs: [{ key: "ghost" }],
      nodes: [{ id: "n", type: "function", input: {}, with: { fn: "compositionEcho" } }],
      edges: line("n"),
    });
    expect(codes(unknown)).toContain("OUTPUT_CHANNEL_UNKNOWN");
  });

  it("requires a placed node's input to be an object", () => {
    const placed = (input: unknown) =>
      graph({
        nodes: [{ id: "n", type: "shell", runsOn: "worker", input, with: { command: "echo" } }],
        edges: line("n"),
      });
    expect(codes(placed(["a", "b"]))).toContain("PLACEMENT_INPUT_NOT_OBJECT");
    expect(codes(placed(7))).toContain("PLACEMENT_INPUT_NOT_OBJECT");
    expect(codes(placed({ a: "b" }))).not.toContain("PLACEMENT_INPUT_NOT_OBJECT");
  });
});
