import { describe, it, expect, beforeAll } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { validateSpec } from "./loader.js";
import { InputValidationError, decodeCliInput, resolveGraphInput } from "./inputs.js";
import { ChannelWriteError } from "./runtime/state-annotation.js";

beforeAll(() => {
  registerFunction("contractValue", (input) => (input as { value?: unknown }).value);
  registerFunction("contractEcho", (input) => input);
  registerFunction("contractLength", (input) => (input as { text: string }).text.length);
});

const graph = (parts: Record<string, unknown>): GraphSpec =>
  ({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "contracts" },
    runtime: { checkpoint: { enabled: false } },
    ...parts,
  }) as unknown as GraphSpec;

const writer = (channel: Record<string, unknown>, value: unknown): GraphSpec =>
  graph({
    state: { channels: { out: channel } },
    nodes: [{ id: "w", type: "function", input: { value }, with: { fn: "contractValue", output: { to: "out" } } }],
    edges: [
      { from: "START", to: "w" },
      { from: "w", to: "END" },
    ],
  });

async function runOf(spec: GraphSpec, input: Record<string, unknown> = {}) {
  const compiled = await compileGraph(spec, {});
  return compiled.run({ input });
}

const errorCodes = (spec: GraphSpec) => validateSpec(spec).filter((d) => d.severity === "error").map((d) => d.code);

describe("channel contracts", () => {
  it("accepts a write that matches the type shorthand", async () => {
    const r = await runOf(writer({ type: "string" }, "hello"));
    expect(r.status).toBe("completed");
    expect(r.state["out"]).toBe("hello");
  });

  it("rejects a write that breaks the type shorthand with a coded error", async () => {
    const r = await runOf(writer({ type: "string" }, 42));
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "CHANNEL_WRITE_INVALID" });
    expect(r.error?.message).toContain('Channel "out" rejected a write');
  });

  it("checks a draft-07 schema on every write", async () => {
    const schema = { type: "object", required: ["title"], properties: { title: { type: "string" } } };
    const ok = await runOf(writer({ type: "object", schema }, { title: "x" }));
    expect(ok.status).toBe("completed");
    const bad = await runOf(writer({ type: "object", schema }, { title: 3 }));
    expect(bad.status).toBe("error");
    expect(bad.error).toMatchObject({ code: "CHANNEL_WRITE_INVALID" });
    expect(bad.error?.message).toContain("/title must be string");
  });

  it("checks the value the channel would hold after the reducer runs", async () => {
    const spec = graph({
      state: { channels: { out: { type: "array", reducer: "append", schema: { type: "array", maxItems: 1 } } } },
      nodes: [
        { id: "a", type: "function", input: { value: "one" }, with: { fn: "contractValue", output: { to: "out" } } },
        { id: "b", type: "function", input: { value: "two" }, with: { fn: "contractValue", output: { to: "out" } } },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "END" },
      ],
    });
    const r = await runOf(spec);
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "CHANNEL_WRITE_INVALID" });
    expect(r.error?.message).toContain("must NOT have more than 1 items");
  });

  it("lets null through, since null is every channel's empty value", async () => {
    const r = await runOf(writer({ type: "string", schema: { type: "string", minLength: 1 } }, null));
    expect(r.status).toBe("completed");
  });

  it("checks values seeded from run input against the channel", async () => {
    const spec = graph({
      state: { channels: { count: { type: "number" } } },
      nodes: [{ id: "n", type: "function", input: { value: 1 }, with: { fn: "contractValue" } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
    });
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: { count: "five" } });
    expect(r.status).toBe("error");
    expect(r.error).toBeInstanceOf(ChannelWriteError);
  });

  it("rejects a schema that contradicts the type, and the removed items and properties fields", () => {
    const messages = (channel: Record<string, unknown>) => {
      const parsed = GraphSpecSchema.safeParse(writer(channel, "x"));
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    expect(messages({ type: "string", schema: { type: "number" } })).toEqual(["schema type number conflicts with type: string"]);
    expect(messages({ type: "array", items: { type: "string" } }).join(" ")).toContain("channel items was removed");
    expect(messages({ type: "object", properties: { a: { type: "string" } } }).join(" ")).toContain("channel properties was removed");
    expect(messages({ type: "array", schema: { type: "array", items: { type: "string" } } })).toEqual([]);
  });

  it("flags a default that does not satisfy the contract", () => {
    const spec = writer({ type: "array", schema: { type: "array", items: { type: "string" } }, default: [1] }, []);
    expect(validateSpec(spec).map((d) => d.code)).toContain("CHANNEL_DEFAULT_TYPE");
  });
});

describe("input contract", () => {
  const spec = graph({
    inputs: [
      { key: "name", type: "string", required: true },
      { key: "limit", type: "number", default: 5 },
      { key: "flags", type: "json", default: { a: 1 } },
    ],
    state: { channels: { seeded: { type: "string" } } },
    nodes: [{ id: "n", type: "function", input: { value: 1 }, with: { fn: "contractValue" } }],
    edges: [
      { from: "START", to: "n" },
      { from: "n", to: "END" },
    ],
  });

  it("applies defaults and gives each run its own copy", () => {
    const first = resolveGraphInput(spec, { name: "a" });
    const second = resolveGraphInput(spec, { name: "b" });
    expect(first).toMatchObject({ name: "a", limit: 5, flags: { a: 1 } });
    (first["flags"] as { a: number }).a = 99;
    expect(second["flags"]).toEqual({ a: 1 });
    expect((spec.inputs?.[2] as { default: unknown }).default).toEqual({ a: 1 });
  });

  it("rejects an undeclared key instead of dropping it", () => {
    expect(() => resolveGraphInput(spec, { name: "a", surprise: 1 })).toThrow(InputValidationError);
    try {
      resolveGraphInput(spec, { name: "a", surprise: 1 });
    } catch (err) {
      expect((err as InputValidationError).code).toBe("INPUT_INVALID");
      expect((err as InputValidationError).errors).toEqual({ surprise: "unknown input" });
    }
  });

  it("accepts a key that is a state channel", () => {
    expect(resolveGraphInput(spec, { name: "a", seeded: "x" })).toMatchObject({ seeded: "x" });
  });

  it("does not coerce: a numeric string is not a number", () => {
    expect(() => resolveGraphInput(spec, { name: "a", limit: "7" })).toThrow(/expected a number/);
  });

  it("treats undefined as missing and null as a value", () => {
    expect(() => resolveGraphInput(spec, { name: undefined })).toThrow(/missing required input/);
    expect(() => resolveGraphInput(spec, { name: "a", limit: null })).toThrow(/expected a number/);
    expect(resolveGraphInput(spec, { name: "a", limit: undefined })).toMatchObject({ limit: 5 });
  });

  it("checks a json input against its schema", () => {
    const withSchema = graph({
      inputs: [{ key: "filters", type: "json", schema: { type: "object", required: ["q"] } }],
      nodes: [{ id: "n", type: "function", input: { value: 1 }, with: { fn: "contractValue" } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
    });
    expect(() => resolveGraphInput(withSchema, { filters: {} })).toThrow(/does not match schema/);
    expect(resolveGraphInput(withSchema, { filters: { q: "x" } })).toEqual({ filters: { q: "x" } });
  });

  it("decodes CLI text once, by declared type", () => {
    const decoded = decodeCliInput(spec, { name: "42", limit: "7", flags: '{"b":2}', seeded: "text" });
    expect(decoded).toEqual({ name: "42", limit: 7, flags: { b: 2 }, seeded: "text" });
    expect(() => decodeCliInput(spec, { limit: "seven" })).toThrow(/expected a number/);
    expect(() => decodeCliInput(spec, { flags: "{nope" })).toThrow(/invalid JSON/);
  });

  it("decodes a boolean input and keeps a string input exactly as written", () => {
    const typed = graph({
      inputs: [
        { key: "on", type: "boolean" },
        { key: "label", type: "string" },
      ],
      nodes: [{ id: "n", type: "function", input: { value: 1 }, with: { fn: "contractValue" } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
    });
    expect(decodeCliInput(typed, { on: "TRUE", label: " 5 " })).toEqual({ on: true, label: " 5 " });
    expect(() => decodeCliInput(typed, { on: "yes" })).toThrow(/expected a boolean/);
  });
});

describe("node input", () => {
  it("renders templates at every depth and accepts non-object values", async () => {
    const spec = graph({
      state: { channels: { name: { type: "string" }, size: { type: "number" } } },
      nodes: [
        { id: "n", type: "function", input: { text: "{{ state.name }}" }, with: { fn: "contractLength", output: { to: "size" } } },
      ],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
    });
    const r = await runOf(spec, { name: "flowgraph" });
    expect(r.state["size"]).toBe(9);

    const list = graph({
      state: { channels: { name: { type: "string" }, out: { type: "array" } } },
      nodes: [
        {
          id: "n",
          type: "function",
          input: ["{{ state.name }}", { nested: ["{{ state.name }}!"] }, 3, null],
          with: { fn: "contractEcho", output: { to: "out" } },
        },
      ],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
    });
    const rl = await runOf(list, { name: "fg" });
    expect(rl.status).toBe("completed");
    expect(rl.state["out"]).toEqual(["fg", { nested: ["fg!"] }, 3, null]);
  });

  it("rejects with.input on a function node", () => {
    const spec = graph({
      nodes: [{ id: "n", type: "function", with: { fn: "contractValue", input: { value: 1 } } }],
      edges: [
        { from: "START", to: "n" },
        { from: "n", to: "END" },
      ],
    });
    expect(errorCodes(spec)).toContain("NODE_CONFIG_ERROR");
  });
});
