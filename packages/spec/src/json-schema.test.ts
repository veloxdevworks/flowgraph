import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import { generateJsonSchema, GraphSpecSchema, MapBodyNodeSchema } from "./index.js";
import { AgentWithSchema, HttpWithSchema, McpWithSchema, ScriptWithSchema, ShellWithSchema, WaitWithSchema } from "./schema.js";
import { GRAPH_JSON_SCHEMA_ID } from "./json-schema.js";

const head = { apiVersion: "flowgraph/v1", kind: "Graph" } as const;
const echo = { type: "shell", with: { command: "echo" } };

function graph(nodes: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...head, metadata: { name: "g" }, nodes, edges: [{ from: "START", to: "END" }], ...extra };
}

function child(nodes: unknown[]): Record<string, unknown> {
  return { ...head, metadata: { name: "child" }, nodes, edges: [{ from: "START", to: "END" }] };
}

const mapOf = (body: unknown) => ({ id: "m", type: "map", with: { over: "{{ state.items }}", node: body } });

function compile() {
  const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true, logger: { log: () => {}, warn: (...args: unknown[]) => { throw new Error(`Ajv strict warning: ${args.join(" ")}`); }, error: () => {} } });
  return ajv.compile(generateJsonSchema());
}

describe("published Graph JSON Schema", () => {
  it("generates without a recursive-reference warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      generateJsonSchema();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("is published at a versioned $id", () => {
    const schema = generateJsonSchema();
    expect(schema.$id).toBe(GRAPH_JSON_SCHEMA_ID);
    expect(GRAPH_JSON_SCHEMA_ID).toMatch(/\/v1\.json$/);
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("keeps the root reference in allOf, so draft-07 does not ignore $id and title beside it", () => {
    const schema = generateJsonSchema();
    expect(schema).not.toHaveProperty("$ref");
    expect(schema.allOf).toEqual([{ $ref: "#/definitions/GraphSpec" }]);
    expect(schema.title).toBe("Flowgraph graph (flowgraph/v1)");
  });

  it("compiles under Ajv strict mode without warnings", () => {
    expect(() => compile()).not.toThrow();
    expect(compile()(graph([{ id: "a", ...echo }]))).toBe(true);
  });

  it("uses recursive definitions for nodes, inline subgraph specs and map bodies", () => {
    const schema = generateJsonSchema() as { definitions: Record<string, { properties: Record<string, unknown> }> };
    expect(Object.keys(schema.definitions).filter((name) => !name.startsWith("With-")).sort()).toEqual(["GraphSpec", "MapBodyNode", "NodeSpec"]);
    expect(schema.definitions.GraphSpec!.properties.nodes).toEqual({ type: "array", items: { $ref: "#/definitions/NodeSpec" } });
    expect(schema.definitions.NodeSpec!.properties.spec).toMatchObject({ $ref: "#/definitions/GraphSpec" });
    expect(schema.definitions.MapBodyNode!.properties.spec).toMatchObject({ $ref: "#/definitions/GraphSpec" });
    expect(schema.definitions["With-map"]!.properties.node).toMatchObject({ $ref: "#/definitions/MapBodyNode" });
    expect(JSON.stringify(schema.definitions.NodeSpec)).toContain('"$ref":"#/definitions/With-map"');
  });

  it("drops relocated settings that the Zod schema rejects", () => {
    const text = JSON.stringify(generateJsonSchema());
    expect(text).not.toContain("x-flowgraph-relocated");
    const schema = generateJsonSchema() as { definitions: Record<string, { properties: Record<string, { properties?: Record<string, { properties?: Record<string, unknown> }> }> }> };
    const graphProps = schema.definitions.GraphSpec!.properties;
    expect(Object.keys(graphProps.config!.properties!.defaults!.properties!)).toEqual(["provider", "model"]);
    expect(graphProps.runtime!.properties).not.toHaveProperty("observability");
    expect(graphProps).not.toHaveProperty("input");
    const channelProps = (graphProps.state!.properties!.channels as { additionalProperties: { properties: Record<string, unknown> } }).additionalProperties.properties;
    expect(channelProps).not.toHaveProperty("items");
    expect(channelProps).not.toHaveProperty("properties");
    const inputFieldProps = (graphProps.inputs as { items: { properties: Record<string, unknown> } }).items.properties;
    expect(inputFieldProps).not.toHaveProperty("label");
    // The canonical node-level retry and timeout stay.
    expect(schema.definitions.NodeSpec!.properties).toHaveProperty("retry");
    expect(schema.definitions.NodeSpec!.properties).toHaveProperty("timeout");
  });

  it("only contains patterns that compile as unicode regexes", () => {
    const text = JSON.stringify(generateJsonSchema());
    const patterns = [...text.matchAll(/"pattern":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string);
    expect(patterns).toContain("^route:");
    for (const pattern of patterns) expect(() => new RegExp(pattern, "u")).not.toThrow();
  });

  it("agrees with the Zod schema on nested graphs", () => {
    const validate = compile();
    const samples: Array<[string, unknown]> = [
      ["inline subgraph", graph([{ id: "sub", type: "subgraph", spec: child([{ id: "a", ...echo }]) }])],
      ["map body", graph([mapOf(echo)])],
      ["map body with an inline subgraph", graph([mapOf({ type: "subgraph", spec: child([{ id: "a", ...echo }]) })])],
      ["map in a map", graph([mapOf({ type: "map", with: { over: "{{ item.xs }}", node: echo } })])],
      ["inline node without a type", graph([{ id: "sub", type: "subgraph", spec: child([{ id: "a" }]) }])],
      ["inline spec without apiVersion", graph([{ id: "sub", type: "subgraph", spec: { metadata: { name: "c" }, nodes: [], edges: [] } }])],
      ["map body without a type", graph([mapOf({ with: { command: "echo" } })])],
      ["map body with a typo", graph([mapOf({ ...echo, wth: {} })])],
      ["nested map body without a type", graph([mapOf({ type: "map", with: { over: "x", node: { id: "y" } } })])],
      ["relocated setting", graph([{ id: "a", ...echo }], { config: { defaults: { retry: { maxAttempts: 2 } } } })],
    ];
    for (const [name, sample] of samples) {
      const zod = GraphSpecSchema.safeParse(sample).success;
      const nestedZod = zod && nestedBodiesParse(sample);
      expect({ name, json: validate(sample) }).toEqual({ name, json: nestedZod });
    }
  });

  it("agrees with the Zod schemas on each node type's `with` block", () => {
    const validate = compile();
    const zodWith: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {
      agent: AgentWithSchema,
      http: HttpWithSchema,
      mcp: McpWithSchema,
      script: ScriptWithSchema,
      shell: ShellWithSchema,
      wait: WaitWithSchema,
    };
    const samples: Array<[string, string, Record<string, unknown> | undefined]> = [
      ["shell", "shell", { command: "echo" }],
      ["shell with a typo", "shell", { command: "echo", timeot: 3 }],
      ["shell without a command", "shell", {}],
      ["shell without a with", "shell", undefined],
      ["agent", "agent", { prompt: "hi" }],
      ["agent with a typo", "agent", { promt: "hi" }],
      ["http", "http", { url: "https://example.com" }],
      ["http with a typo", "http", { url: "https://example.com", mehtod: "GET" }],
      ["wait on a deadline", "wait", { deadline: "5s" }],
      ["wait with nothing", "wait", {}],
      ["wait with two modes", "wait", { deadline: "5s", signal: "go" }],
      ["mcp tool", "mcp", { server: "s", tool: "t" }],
      ["mcp tool and resource", "mcp", { server: "s", tool: "t", resource: "r" }],
      ["mcp neither", "mcp", { server: "s" }],
      ["script with code", "script", { code: "1" }],
      ["script with code and file", "script", { code: "1", file: "a.js" }],
    ];
    for (const [name, type, withBlock] of samples) {
      const zod = zodWith[type]!.safeParse(withBlock ?? {}).success;
      const node = { id: "n", type, ...(withBlock ? { with: withBlock } : {}) };
      expect({ name, json: validate(graph([node])) }).toEqual({ name, json: zod });
    }
  });
});

/** Map bodies are typed in Zod through the map node's own `with` schema, which GraphSpecSchema does not apply. */
function nestedBodiesParse(sample: unknown): boolean {
  let ok = true;
  const visit = (node: Record<string, unknown>): void => {
    if (node.type === "map") {
      const body = (node.with as { node?: unknown } | undefined)?.node;
      const parsed = MapBodyNodeSchema.safeParse(body);
      if (!parsed.success) ok = false;
      else visit(body as Record<string, unknown>);
    }
    const spec = node.spec as { nodes?: Array<Record<string, unknown>> } | undefined;
    for (const inner of spec?.nodes ?? []) visit(inner);
  };
  for (const node of (sample as { nodes: Array<Record<string, unknown>> }).nodes) visit(node);
  return ok;
}
