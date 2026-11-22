import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  AgentWithSchema,
  EXTENSION_KEY_PATTERN,
  GraphSpecSchema,
  HitlWithSchema,
  HttpWithSchema,
  McpWithSchema,
  MemoryWithSchema,
  RouterWithSchema,
  ScriptWithSchema,
  ShellWithSchema,
  SkillWithSchema,
  SubgraphWithSchema,
  WaitWithSchema,
  MapWithSchema,
  FunctionWithSchema,
  FailWithSchema,
  engineVersionProblem,
  engineRangeProblem,
} from "./index.js";

function messages(schema: ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const graph = (over: Record<string, unknown> = {}) => ({
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "g" },
  nodes: [{ id: "a", type: "shell", with: { command: "echo" } }],
  edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }],
  ...over,
});

describe("unknown keys inside nested objects", () => {
  it("rejects a misspelled graph section key, with a suggestion", () => {
    expect(messages(GraphSpecSchema, graph({ metadata: { name: "g", nmae: "x" } }))).toEqual(['Unknown field "nmae" (did you mean "name"?)']);
    expect(messages(GraphSpecSchema, graph({ runtime: { recursionlimit: 3 } }))).toEqual(['Unknown field "recursionlimit" (did you mean "recursionLimit"?)']);
  });

  it("rejects a misspelled key in an edge, a hook and a hook's where", () => {
    expect(messages(GraphSpecSchema, graph({ edges: [{ from: "START", to: "a", tooo: "b" }] })).join()).toContain('Unknown field "tooo"');
    expect(messages(GraphSpecSchema, graph({ runtime: { hooks: [{ on: "node:before", do: "allow", wher: {} }] } })).join()).toContain('Unknown field "wher"');
    expect(messages(GraphSpecSchema, graph({ runtime: { hooks: [{ on: "node:before", do: "allow", where: { nodeid: "a" } }] } })).join()).toContain('Unknown field "nodeid"');
  });

  it("rejects a misspelled key in a node's with, for each node type", () => {
    const cases: Array<[string, ZodTypeAny, Record<string, unknown>, string]> = [
      ["shell", ShellWithSchema, { command: "echo", timeot: 3 }, "timeot"],
      ["agent", AgentWithSchema, { prompt: "hi", promt: "hi" }, "promt"],
      ["http", HttpWithSchema, { url: "https://example.com", mehtod: "GET" }, "mehtod"],
      ["script", ScriptWithSchema, { code: "1", cod: "2" }, "cod"],
      ["skill", SkillWithSchema, { outptu: {} }, "outptu"],
      ["function", FunctionWithSchema, { fn: "f", fnn: "g" }, "fnn"],
      ["fail", FailWithSchema, { reason: "no", reaosn: "x" }, "reaosn"],
      ["router", RouterWithSchema, { routes: [{ name: "a", to: "a", default: true }], rotues: [] }, "rotues"],
      ["wait", WaitWithSchema, { deadline: "5s", deadlin: "5s" }, "deadlin"],
      ["mcp", McpWithSchema, { server: "s", tool: "t", srever: "s" }, "srever"],
      ["map", MapWithSchema, { over: "{{ state.xs }}", node: { type: "shell", with: { command: "x" } }, ovr: 1 }, "ovr"],
      ["subgraph", SubgraphWithSchema, { outptu: {} }, "outptu"],
      ["memory", MemoryWithSchema, { op: "search", prefix: "p", prefx: "p" }, "prefx"],
    ];
    for (const [name, schema, value, key] of cases) {
      expect(messages(schema, value).join(), name).toContain(`Unknown field "${key}"`);
    }
  });

  it("keeps maps that hold the author's own data open", () => {
    expect(GraphSpecSchema.safeParse(graph({ state: { channels: { out: { type: "object", default: { anything: 1 } } } } })).success).toBe(true);
    expect(HttpWithSchema.safeParse({ url: "https://example.com", headers: { "X-Anything": "1" } }).success).toBe(true);
    expect(ShellWithSchema.safeParse({ command: "echo", env: { WHATEVER: "1" } }).success).toBe(true);
  });
});

describe("exclusive modes", () => {
  it("wait takes exactly one of deadline, until, signal or webhook", () => {
    expect(messages(WaitWithSchema, {}).join()).toContain("wait needs one of");
    expect(messages(WaitWithSchema, { deadline: "5s", signal: "go" }).join()).toContain("not several");
    expect(messages(WaitWithSchema, { deadline: "5s", timeout: "1h" }).join()).toContain("timeout");
    for (const mode of [{ deadline: "5s" }, { until: "{{ state.ready }}" }, { signal: "go" }, { webhook: true }]) {
      expect(messages(WaitWithSchema, mode), JSON.stringify(mode)).toEqual([]);
    }
  });

  it("mcp takes exactly one of tool or resource", () => {
    expect(messages(McpWithSchema, { server: "s" }).join()).toMatch(/tool.*resource/);
    expect(messages(McpWithSchema, { server: "s", tool: "t", resource: "r" }).join()).toContain("not both");
    expect(messages(McpWithSchema, { server: "s", tool: "t" })).toEqual([]);
    expect(messages(McpWithSchema, { server: "s", resource: "r" })).toEqual([]);
  });

  it("hitl choice needs choices, and approve cannot take both choices and a schema", () => {
    expect(messages(HitlWithSchema, { mode: "choice", message: "pick" }).join()).toContain("choices");
    expect(messages(HitlWithSchema, { mode: "choice", message: "pick", choices: ["a", "b"] })).toEqual([]);
    expect(messages(HitlWithSchema, { mode: "approve", message: "ok?", choices: ["a"], schema: { type: "object" } }).join()).toContain("choices");
    expect(messages(HitlWithSchema, { mode: "approve", message: "ok?" })).toEqual([]);
  });

  it("router rules mode takes no model input", () => {
    expect(messages(RouterWithSchema, { routes: [{ name: "a", to: "a", when: "true" }], input: "x" }).join()).toContain("input");
  });

  it("http rejects a body on GET", () => {
    expect(messages(HttpWithSchema, { url: "https://example.com", method: "GET", body: { a: 1 } }).join()).toContain("body");
    expect(messages(HttpWithSchema, { url: "https://example.com", method: "POST", body: { a: 1 } })).toEqual([]);
  });

  it("memory rejects fields the operation does not use", () => {
    expect(messages(MemoryWithSchema, { op: "search", prefix: "p", value: 1 }).join()).toContain('op "search" does not use value');
  });

  it("an edge takes `to` or `branch`, not both and not neither", () => {
    const both = { from: "a", to: "END", branch: [{ when: "true", to: "END" }] };
    expect(messages(GraphSpecSchema, graph({ edges: [{ from: "START", to: "a" }, both] })).join()).toContain("not several");
    expect(messages(GraphSpecSchema, graph({ edges: [{ from: "START" }] })).join()).toContain("An edge needs");
    expect(messages(GraphSpecSchema, graph({ edges: [{ from: "START", to: "a" }, { from: "a", branch: [{ when: "true", to: "END" }] }] }))).toEqual([]);
  });
});

describe("extensions and requires", () => {
  it("accepts namespaced extension keys and refuses bare ones", () => {
    expect(GraphSpecSchema.safeParse(graph({ extensions: { "acme.catalog": { owner: "x" } } })).success).toBe(true);
    expect(GraphSpecSchema.safeParse(graph({ extensions: { catalog: {} } })).success).toBe(false);
    for (const key of ["acme.catalog", "acme-co.team.name", "a.B_c"]) expect(EXTENSION_KEY_PATTERN.test(key), key).toBe(true);
    for (const key of ["catalog", "Acme.catalog", ".x", "acme."]) expect(EXTENSION_KEY_PATTERN.test(key), key).toBe(false);
  });

  it("refuses unknown data at the top level", () => {
    expect(GraphSpecSchema.safeParse(graph({ owner: "x" })).success).toBe(false);
  });

  it("checks requires.engine is a semver range", () => {
    expect(GraphSpecSchema.safeParse(graph({ requires: { engine: ">=1.0.0 <2" } })).success).toBe(true);
    expect(GraphSpecSchema.safeParse(graph({ requires: { engine: "soon" } })).success).toBe(false);
    expect(GraphSpecSchema.safeParse(graph({ requires: { engines: ">=1" } })).success).toBe(false);
    expect(engineRangeProblem("^1.2.0")).toBeUndefined();
    expect(engineRangeProblem("nope")).toBeDefined();
  });

  it("explains an unmet engine range", () => {
    expect(engineVersionProblem(">=1.0.0", "1.2.0")).toBeUndefined();
    expect(engineVersionProblem(">=2.0.0", "1.2.0")).toMatch(/requires flowgraph >=2\.0\.0, but this is flowgraph 1\.2\.0/);
  });
});

describe("toolInput", () => {
  const node = (toolInput: unknown) => graph({ nodes: [{ id: "a", type: "shell", toolInput, with: { command: "echo" } }] });

  it("accepts a draft-07 object schema", () => {
    expect(GraphSpecSchema.safeParse(node({ type: "object", properties: { q: { type: "string" } }, required: ["q"] })).success).toBe(true);
  });

  it("rejects a schema that is not valid draft-07", () => {
    expect(GraphSpecSchema.safeParse(node({ type: "object", properties: { q: { type: "strnig" } } })).success).toBe(false);
    expect(GraphSpecSchema.safeParse(node({ type: "string" })).success).toBe(false);
  });
});
