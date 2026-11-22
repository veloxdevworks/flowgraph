import { describe, expect, it } from "vitest";
import {
  ChannelSchema,
  GraphSpecSchema,
  InputFieldSchema,
  MapWithSchema,
  OutputFieldSchema,
  ShellWithSchema,
  SubgraphWithSchema,
} from "./schema.js";
import { channelValueProblem, compileChannelContract, inputFieldChannel } from "./channel-contract.js";
import { inputValueProblem } from "./input-contract.js";

const messageOf = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string =>
  result.error?.issues.map((i) => i.message).join("; ") ?? "";

const graph = (extra: Record<string, unknown>) => ({
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "t" },
  nodes: [{ id: "a", type: "function", with: { fn: "f" } }],
  edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }],
  ...extra,
});

describe("channel contracts", () => {
  it("accepts a type, a draft-07 schema, or both when they agree", () => {
    expect(ChannelSchema.safeParse({ type: "string" }).success).toBe(true);
    expect(ChannelSchema.safeParse({ type: "object", schema: { type: "object", required: ["id"] } }).success).toBe(true);
    expect(ChannelSchema.safeParse({ type: "number", schema: { type: "integer" } }).success).toBe(true);
  });

  it("rejects a schema that contradicts the type", () => {
    const result = ChannelSchema.safeParse({ type: "string", schema: { type: "object" } });
    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain("conflicts with type: string");
  });

  it("rejects a schema the dialect does not accept", () => {
    const result = ChannelSchema.safeParse({ type: "object", schema: { type: "object", properties: { a: { type: "any" } } } });
    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain("invalid JSON Schema");
  });

  it("points items and properties at schema", () => {
    expect(messageOf(ChannelSchema.safeParse({ type: "array", items: { type: "string" } }))).toContain("with schema");
    expect(messageOf(ChannelSchema.safeParse({ type: "object", properties: {} }))).toContain("with schema");
  });

  it("checks a value against the type shorthand", () => {
    expect(channelValueProblem({ type: "string" }, "x")).toBeUndefined();
    expect(channelValueProblem({ type: "string" }, 1)).toBe("/ must be string");
    expect(channelValueProblem({ type: "number" }, Number.NaN)).toBe("/ must be number");
    expect(channelValueProblem({ type: "object" }, [])).toBe("/ must be object");
    expect(channelValueProblem({ type: "array" }, {})).toBe("/ must be array");
    expect(channelValueProblem({ type: "any" }, { whatever: true })).toBeUndefined();
    expect(compileChannelContract({ type: "any" })).toBeUndefined();
  });

  it("checks a value against the schema alone when one is given", () => {
    const channel = { type: "array", schema: { type: "array", items: { type: "string" } } };
    expect(channelValueProblem(channel, ["a"])).toBeUndefined();
    expect(channelValueProblem(channel, ["a", 2])).toBe("/1 must be string");
  });
});

describe("input contracts", () => {
  it("keeps presentation under ui", () => {
    expect(InputFieldSchema.safeParse({ key: "n", ui: { label: "Name", widget: "textarea" } }).success).toBe(true);
    expect(messageOf(InputFieldSchema.safeParse({ key: "n", label: "Name" }))).toContain("ui.label");
  });

  it("no longer has a text type", () => {
    expect(messageOf(InputFieldSchema.safeParse({ key: "n", type: "text" }))).toContain("type: string");
  });

  it("allows a schema only on json inputs", () => {
    expect(InputFieldSchema.safeParse({ key: "n", type: "json", schema: { type: "object" } }).success).toBe(true);
    expect(messageOf(InputFieldSchema.safeParse({ key: "n", schema: { type: "object" } }))).toContain("only allowed on type: json");
  });

  it("rejects unknown keys on a field", () => {
    expect(InputFieldSchema.safeParse({ key: "n", colour: "red" }).success).toBe(false);
  });

  it("checks a value without coercing it", () => {
    expect(inputValueProblem({ type: "number" }, 3)).toBeUndefined();
    expect(inputValueProblem({ type: "number" }, "3")).toBe("expected a number");
    expect(inputValueProblem({ type: "boolean" }, "true")).toBe("expected a boolean");
    expect(inputValueProblem({ type: "string" }, 3)).toBe("expected a string");
    expect(inputValueProblem({ type: "select", options: ["a"] }, "b")).toBe("must be one of: a");
    expect(inputValueProblem({ type: "json" }, "plain text")).toBeUndefined();
    expect(inputValueProblem({ type: "json", schema: { type: "object" } }, [])).toContain("does not match schema");
  });

  it("seeds a declared input into a channel of the same type", () => {
    expect(inputFieldChannel({ type: "number" })).toEqual({ type: "number" });
    expect(inputFieldChannel({ type: "select" })).toEqual({ type: "string" });
    expect(inputFieldChannel({ type: "json", schema: { type: "array" } })).toEqual({ type: "any", schema: { type: "array" } });
  });

  it("removes the top-level input field", () => {
    const result = GraphSpecSchema.safeParse(graph({ input: { topic: "x" } }));
    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain("top-level input was removed");
  });
});

describe("declared outputs", () => {
  it("accepts a key with an optional contract", () => {
    expect(OutputFieldSchema.safeParse({ key: "summary", type: "string", required: false }).success).toBe(true);
    expect(OutputFieldSchema.safeParse({ key: "rows", schema: { type: "array" } }).success).toBe(true);
  });

  it("rejects a schema that contradicts the type", () => {
    expect(OutputFieldSchema.safeParse({ key: "k", type: "string", schema: { type: "array" } }).success).toBe(false);
  });

  it("is a list on the graph", () => {
    expect(GraphSpecSchema.safeParse(graph({ outputs: [{ key: "result" }] })).success).toBe(true);
    expect(GraphSpecSchema.safeParse(graph({ outputs: { result: {} } })).success).toBe(false);
  });
});

describe("node input", () => {
  it("is one path: the node's input, not with.input", () => {
    const result = ShellWithSchema.safeParse({ command: "echo", input: { a: 1 } });
    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain("set the node's own input");
  });

  it("accepts any value on the node", () => {
    for (const input of [{ a: 1 }, ["x"], "{{ state.q }}", 3, true, null]) {
      const spec = graph({ nodes: [{ id: "a", type: "function", with: { fn: "f" }, input }] });
      expect(GraphSpecSchema.safeParse(spec).success).toBe(true);
    }
  });
});

describe("map binding", () => {
  const base = { over: "{{ state.xs }}", node: { type: "function", with: { fn: "f" } } };

  it("defaults the binding to item", () => {
    expect(MapWithSchema.parse(base).as).toBe("item");
  });

  it("takes an identifier that no template already binds", () => {
    expect(MapWithSchema.safeParse({ ...base, as: "file" }).success).toBe(true);
    expect(MapWithSchema.safeParse({ ...base, as: "my file" }).success).toBe(false);
    for (const name of ["index", "state", "input", "config", "run", "secret"]) {
      expect(MapWithSchema.safeParse({ ...base, as: name }).success).toBe(false);
    }
  });

  it("rejects with.output instead of dropping it", () => {
    const result = MapWithSchema.safeParse({ ...base, output: { to: "x" } });
    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain("with.collect");
  });
});

describe("subgraph state mapping", () => {
  it("rejects stateMap.out together with output", () => {
    const result = SubgraphWithSchema.safeParse({ stateMap: { out: { a: "b" } }, output: { to: "c" } });
    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain("stateMap.out");
  });

  it("allows either on its own", () => {
    expect(SubgraphWithSchema.safeParse({ stateMap: { out: { a: "b" } } }).success).toBe(true);
    expect(SubgraphWithSchema.safeParse({ output: { to: "c" } }).success).toBe(true);
  });
});
