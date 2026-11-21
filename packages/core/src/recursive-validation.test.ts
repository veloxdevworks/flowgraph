import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { loadGraph, validateSpec } from "./loader.js";
import { cronScheduleProblem, isKnownTimeZone } from "./runtime/cron-schedule.js";

const head = { apiVersion: "flowgraph/v1", kind: "Graph" } as const;

function graph(nodes: unknown[], extra: Record<string, unknown> = {}): GraphSpec {
  const first = (nodes[0] as { id: string }).id;
  return {
    ...head,
    metadata: { name: "g" },
    nodes,
    edges: [{ from: "START", to: first }, { from: first, to: "END" }],
    ...extra,
  } as unknown as GraphSpec;
}

const echo = { type: "shell", with: { command: "echo", args: ["hi"] } };

function errors(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

function mapOf(body: unknown): unknown {
  return { id: "m", type: "map", with: { over: "{{ state.items }}", node: body } };
}

function inline(nodes: unknown[], edges?: unknown[]): unknown {
  const first = (nodes[0] as { id: string }).id;
  return {
    id: "sub",
    type: "subgraph",
    spec: { ...head, metadata: { name: "child" }, nodes, edges: edges ?? [{ from: "START", to: first }, { from: first, to: "END" }] },
  };
}

describe("map bodies are validated before running", () => {
  it("reports a map body shell with no command", async () => {
    const spec = graph([mapOf({ type: "shell", with: {} })]);
    expect(errors(validateSpec(spec))).toEqual([
      expect.objectContaining({ code: "NODE_CONFIG_ERROR", path: "nodes.m.with.node.with.command" }),
    ]);
    await expect(compileGraph(spec)).rejects.toMatchObject({
      code: "NODE_CONFIG_ERROR",
      message: expect.stringContaining("nodes.m.with.node.with.command"),
    });
  });

  it("reports an unregistered map body type", () => {
    expect(errors(validateSpec(graph([mapOf({ type: "shel", with: { command: "echo" } })])))).toEqual([
      expect.objectContaining({ code: "UNKNOWN_NODE_TYPE", path: "nodes.m.with.node.type", message: 'Map "m" body has unregistered type "shel"' }),
    ]);
  });

  it("types the map body as a node, so a typo or a missing type is reported", () => {
    const typo = errors(validateSpec(graph([mapOf({ ...echo, wth: {} })])));
    expect(typo).toContainEqual(expect.objectContaining({ code: "NODE_CONFIG_ERROR", path: "nodes.m.with.node" }));
    expect(typo[0]!.message).toContain("wth");
    expect(errors(validateSpec(graph([mapOf({ with: { command: "echo" } })])))).toEqual([
      expect.objectContaining({ code: "NODE_CONFIG_ERROR", path: "nodes.m.with.node.type" }),
    ]);
  });

  it("accepts a valid map body, with or without an id", () => {
    expect(errors(validateSpec(graph([mapOf(echo)])))).toEqual([]);
    expect(errors(validateSpec(graph([mapOf({ id: "item", ...echo })])))).toEqual([]);
  });
});

describe("inline subgraph specs are validated like the top-level graph", () => {
  it("reports node, edge and start errors inside the child, with child paths", async () => {
    const spec = graph([
      inline(
        [{ id: "x", type: "shell", with: {} }],
        [{ from: "x", to: "ghost" }],
      ),
    ]);
    const found = errors(validateSpec(spec));
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_NODE_REF", path: "nodes.sub.spec.edges[0]" }),
      expect.objectContaining({ code: "NO_START_EDGE", path: "nodes.sub.spec.edges" }),
      expect.objectContaining({ code: "NODE_CONFIG_ERROR", path: "nodes.sub.spec.nodes.x.with.command" }),
    ]));
    await expect(compileGraph(spec)).rejects.toThrow(/Invalid graph: .*nodes\.sub\.spec\.nodes\.x\.with\.command/);
  });

  it("checks a subgraph body's inline spec inside a map", () => {
    const body = { type: "subgraph", spec: { ...head, metadata: { name: "item" }, nodes: [{ id: "y", type: "shell", with: {} }], edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }] } };
    expect(errors(validateSpec(graph([mapOf(body)])))).toEqual([
      expect.objectContaining({ code: "NODE_CONFIG_ERROR", path: "nodes.m.with.node.spec.nodes.y.with.command" }),
    ]);
  });

  it("runs the child's own topology lints", () => {
    const spec = graph([inline([{ id: "a", ...echo }, { id: "orphan", ...echo }], [{ from: "START", to: "a" }, { from: "a", to: "END" }])]);
    expect(validateSpec(spec)).toContainEqual(
      expect.objectContaining({ severity: "error", code: "UNREACHABLE_FROM_START", path: "nodes.sub.spec.nodes.orphan" }),
    );
  });

  it("accepts a valid inline subgraph without nested diagnostics", () => {
    const spec = graph([inline([{ id: "a", ...echo }])]);
    expect(validateSpec(spec).filter((d) => d.path?.startsWith("nodes.sub.spec"))).toEqual([]);
  });
});

describe("edges into START and out of END", () => {
  it("rejects END as a source in validate and compile", async () => {
    const spec = graph([{ id: "a", ...echo }]);
    spec.edges.push({ from: "END", to: "a" });
    expect(validateSpec(spec)).toContainEqual(expect.objectContaining({ severity: "error", code: "EDGE_FROM_END", path: "edges[2].from" }));
    await expect(compileGraph(spec)).rejects.toMatchObject({ code: "EDGE_FROM_END" });
  });

  it("rejects START as a target, on a static edge or a branch", async () => {
    const spec = graph([{ id: "a", ...echo }]);
    spec.edges.push({ from: "a", to: "START" }, { from: "a", branch: [{ when: "true", to: "START" }] });
    const found = validateSpec(spec).filter((d) => d.code === "EDGE_TO_START");
    expect(found.map((d) => d.path)).toEqual(["edges[2]", "edges[3]"]);
    await expect(compileGraph(spec)).rejects.toMatchObject({ code: "EDGE_TO_START" });
  });

  it("rejects START as a router route target", async () => {
    const spec = graph([{ id: "r", type: "router", with: { mode: "rules", routes: { again: { default: true, to: "START" } } } }]);
    expect(errors(validateSpec(spec))).toContainEqual(expect.objectContaining({ code: "ROUTE_TO_START", path: "nodes.r.with.routes" }));
    await expect(compileGraph(spec)).rejects.toMatchObject({ code: "ROUTE_TO_START" });
  });

  it("rejects START as a hitl route target, including inside an inline spec", async () => {
    const gate = { id: "h", type: "hitl", with: { message: "ok?", routes: { approved: "START", rejected: "END" } } };
    expect(errors(validateSpec(graph([gate])))).toContainEqual(expect.objectContaining({ code: "ROUTE_TO_START", path: "nodes.h.with.routes" }));
    const nestedSpec = graph([inline([gate])]);
    expect(errors(validateSpec(nestedSpec))).toContainEqual(expect.objectContaining({ code: "ROUTE_TO_START", path: "nodes.sub.spec.nodes.h.with.routes" }));
    await expect(compileGraph(nestedSpec)).rejects.toMatchObject({ code: "ROUTE_TO_START" });
  });
});

describe("body lints have the same severity at compile time at every level", () => {
  // Approve mode answers approved or rejected; this gate routes only one of them.
  const gate = { id: "h", type: "hitl", with: { message: "ok?", routes: { approved: "END" } } };

  it("reports a hitl with a missing route at validate time, at the top level and nested", () => {
    const top = errors(validateSpec(graph([gate]))).find((d) => d.path?.startsWith("nodes.h.with.routes"));
    const nestedOne = errors(validateSpec(graph([inline([gate])]))).find((d) => d.path?.startsWith("nodes.sub.spec.nodes.h.with.routes"));
    expect(top).toBeDefined();
    expect(nestedOne).toMatchObject({ code: top!.code, severity: "error" });
  });

  it("compiles the same way whether the gate is top level or nested", async () => {
    const outcome = async (spec: GraphSpec) => compileGraph(spec, { checkpointer: "none" }).then(() => "compiled", (err: Error) => err.message);
    expect(await outcome(graph([inline([gate])]))).toBe(await outcome(graph([gate])));
  });
});

describe("undeclared output channels", () => {
  it("are a warning, and compile keeps the write", async () => {
    const spec = graph([{ id: "a", type: "function", with: { fn: "noop", output: { to: "result" } } }]);
    const diag = validateSpec(spec).find((d) => d.code === "UNDECLARED_OUTPUT_CHANNEL");
    expect(diag).toMatchObject({ severity: "warning", path: "nodes.a.with.output" });
    const { registerFunction } = await import("./nodes/function.js");
    registerFunction("noop", () => "kept");
    const result = await (await compileGraph(spec, { checkpointer: "none" })).run({ input: {} });
    expect(result.state.result).toBe("kept");
  });
});

describe("graph inputs", () => {
  it("needs options for a select, unique keys, and defaults of the declared type", () => {
    const spec = graph([{ id: "a", ...echo }], {
      inputs: [
        { key: "mode", type: "select" },
        { key: "count", type: "number", default: "5" },
        { key: "count", type: "string" },
        { key: "on", type: "boolean", default: "yes" },
        { key: "tier", type: "select", options: ["a", "b"], default: "c" },
        { key: "data", type: "json", default: "{not json" },
        { key: "title", default: 3 },
      ],
    });
    const found = validateSpec(spec).filter((d) => d.path?.startsWith("inputs"));
    expect(found.map((d) => [d.code, d.path])).toEqual([
      ["INPUT_OPTIONS_MISSING", "inputs[0].options"],
      ["INPUT_DEFAULT_TYPE", "inputs[1].default"],
      ["DUPLICATE_INPUT_KEY", "inputs[2].key"],
      ["INPUT_DEFAULT_TYPE", "inputs[3].default"],
      ["INPUT_DEFAULT_TYPE", "inputs[4].default"],
      ["INPUT_DEFAULT_TYPE", "inputs[5].default"],
      ["INPUT_DEFAULT_TYPE", "inputs[6].default"],
    ]);
    expect(found.every((d) => d.severity === "error")).toBe(true);
  });

  it("are validate-time only: compile still accepts malformed inputs", async () => {
    const spec = graph([{ id: "a", ...echo }], { inputs: [{ key: "mode", type: "select" }, { key: "mode" }] });
    await expect(compileGraph(spec, { checkpointer: "none" })).resolves.toBeDefined();
  });

  it("accepts well-formed inputs", () => {
    const spec = graph([{ id: "a", ...echo }], {
      inputs: [
        { key: "mode", type: "select", options: ["fast", "slow"], default: "fast" },
        { key: "count", type: "number", default: 5 },
        { key: "on", type: "boolean", default: false },
        { key: "data", type: "json", default: { a: 1 } },
        { key: "raw", type: "json", default: "[1, 2]" },
        { key: "note", type: "text", default: "hi" },
        { key: "plain" },
      ],
    });
    expect(validateSpec(spec).filter((d) => d.path?.startsWith("inputs"))).toEqual([]);
  });
});

describe("triggers", () => {
  it("rejects a bad cron schedule, an unknown time zone and a repeated id", () => {
    const spec = graph([{ id: "a", ...echo }], {
      triggers: [
        { id: "nightly", type: "cron", schedule: "0 2 * *" },
        { id: "hourly", type: "cron", schedule: "61 * * * *" },
        { id: "local", type: "cron", schedule: "0 9 * * MON-FRI", timezone: "Mars/Olympus" },
        { id: "nightly", type: "startup" },
      ],
    });
    const found = validateSpec(spec).filter((d) => d.path?.startsWith("triggers"));
    expect(found.map((d) => [d.code, d.path])).toEqual([
      ["TRIGGER_CRON_INVALID", "triggers[0].schedule"],
      ["TRIGGER_CRON_INVALID", "triggers[1].schedule"],
      ["TRIGGER_TIMEZONE_INVALID", "triggers[2].timezone"],
      ["DUPLICATE_TRIGGER_ID", "triggers[3].id"],
    ]);
    expect(found[0]!.message).toContain("expected 5 fields");
    expect(found[1]!.message).toContain('minute "61" is out of range (0-59)');
  });

  it("accepts standard schedules with ranges, lists, steps, names, seconds and macros", () => {
    const spec = graph([{ id: "a", ...echo }], {
      triggers: [
        { id: "a", type: "cron", schedule: "*/15 9-17 * * mon-fri", timezone: "America/Denver" },
        { id: "b", type: "cron", schedule: "0 0 1,15 JAN-JUN/2 0,7", timezone: "UTC" },
        { id: "c", type: "cron", schedule: "5 4 * * 7" },
        { id: "d", type: "cron", schedule: "30 */5 * * * *" },
        ...["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@hourly"].map((schedule) => ({ id: schedule, type: "cron", schedule })),
      ],
    });
    expect(validateSpec(spec).filter((d) => d.path?.startsWith("triggers"))).toEqual([]);
  });

  it("are validate-time only: compile still accepts a graph whose triggers fail validation", async () => {
    const spec = graph([{ id: "a", ...echo }], {
      triggers: [
        { id: "t", type: "cron", schedule: "not cron", timezone: "Mars/Olympus" },
        { id: "t", type: "startup" },
      ],
    });
    await expect(compileGraph(spec, { checkpointer: "none" })).resolves.toBeDefined();
  });
});

describe("cronScheduleProblem", () => {
  it("accepts an optional leading seconds field and the standard macros", () => {
    expect(cronScheduleProblem("0 0 2 * * *")).toBeUndefined();
    expect(cronScheduleProblem("@daily")).toBeUndefined();
    expect(cronScheduleProblem("  @hourly ")).toBeUndefined();
  });

  it("rejects unknown macros, out-of-range seconds and the wrong field count", () => {
    expect(cronScheduleProblem("@reboot")).toContain('unknown macro "@reboot"');
    expect(cronScheduleProblem("60 0 2 * * *")).toContain('second "60" is out of range (0-59)');
    expect(cronScheduleProblem("0 0 0 2 * * *")).toContain("got 7");
    expect(cronScheduleProblem("")).toContain("got 0");
  });
});

describe("isKnownTimeZone", () => {
  it("accepts canonical IANA names and UTC", () => {
    for (const zone of ["America/Denver", "Europe/London", "Asia/Tokyo", "UTC"]) expect(isKnownTimeZone(zone)).toBe(true);
  });

  it("rejects abbreviations, offsets, other spellings and unknown names", () => {
    for (const zone of ["EST", "+05:00", "america/denver", "AMERICA/DENVER", "utc", " UTC", "", "Mars/Olympus"]) {
      expect(isKnownTimeZone(zone), zone).toBe(false);
    }
  });
});

describe("script code is not linted as a template", () => {
  const jsx = 'export default () => `<div style={{ color: "red" }} />`;';

  it("validates JSX style={{ }} in script.with.code", () => {
    const spec = graph([{ id: "s", type: "script", with: { code: jsx } }]);
    expect(errors(validateSpec(spec))).toEqual([]);
  });

  it("still checks templates in the script's other fields", () => {
    const spec = graph([{ id: "s", type: "script", with: { code: jsx, input: { x: "{{ state. }}" } } }]);
    expect(errors(validateSpec(spec))).toContainEqual(expect.objectContaining({ code: "EXPR_PARSE_ERROR", path: "nodes.s.with.input.x" }));
  });

  it("still checks script code in a map body, which the map renders with the item", () => {
    const spec = graph([mapOf({ type: "script", with: { code: jsx } })]);
    expect(errors(validateSpec(spec))).toContainEqual(expect.objectContaining({ code: "EXPR_PARSE_ERROR", path: "nodes.m.with.node.with.code" }));
  });
});

describe("loadGraph and subgraph files", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function write(files: Record<string, string>): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-recursive-"));
    for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
    return dir;
  }

  const yamlHead = "apiVersion: flowgraph/v1\nkind: Graph\n";

  it("validates a uses file and names the file in its diagnostics", async () => {
    const root = await write({
      "parent.graph.yaml": `${yamlHead}metadata: { name: parent }\nnodes:\n  - { id: call, type: subgraph, uses: ./child.graph.yaml }\nedges:\n  - { from: START, to: call }\n  - { from: call, to: END }\n`,
      "child.graph.yaml": `${yamlHead}metadata: { name: child }\nnodes:\n  - { id: m, type: map, with: { over: "{{ state.items }}", node: { type: shell, with: {} } } }\nedges:\n  - { from: START, to: m }\n  - { from: m, to: END }\n`,
    });
    const { spec, diagnostics } = await loadGraph(path.join(root, "parent.graph.yaml"));
    expect(spec).not.toBeNull();
    expect(errors(diagnostics)).toEqual([
      expect.objectContaining({ code: "NODE_CONFIG_ERROR", path: "nodes.m.with.node.with.command", file: path.join(root, "child.graph.yaml") }),
    ]);
  });

  it("reports a plugin type in a uses file as unresolved when a graph above it imports node modules", async () => {
    const root = await write({
      "plugin.mjs": "export default {};\n",
      "parent.graph.yaml": `${yamlHead}metadata: { name: parent }\nimports:\n  - { nodes: ./plugin.mjs }\nnodes:\n  - { id: call, type: subgraph, uses: ./child.graph.yaml }\nedges:\n  - { from: START, to: call }\n  - { from: call, to: END }\n`,
      "child.graph.yaml": `${yamlHead}metadata: { name: child }\nnodes:\n  - { id: p, type: acme-widget }\nedges:\n  - { from: START, to: p }\n  - { from: p, to: END }\n`,
    });
    const { diagnostics } = await loadGraph(path.join(root, "parent.graph.yaml"));
    expect(errors(diagnostics)).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", code: "PLUGIN_TYPE_UNRESOLVED", path: "nodes.p.type" }));
  });

  it("normalises deprecated type aliases inside inline subgraph specs", async () => {
    const root = await write({
      "g.graph.yaml": [
        `${yamlHead}metadata: { name: g }`,
        "nodes:",
        "  - id: sub",
        "    type: subgraph",
        "    spec:",
        "      apiVersion: flowgraph/v1",
        "      kind: Graph",
        "      metadata: { name: child }",
        "      nodes:",
        "        - { id: f, type: code, with: { fn: noop } }",
        "      edges:",
        "        - { from: START, to: f }",
        "        - { from: f, to: END }",
        "edges:",
        "  - { from: START, to: sub }",
        "  - { from: sub, to: END }",
        "",
      ].join("\n"),
    });
    const { spec, diagnostics } = await loadGraph(path.join(root, "g.graph.yaml"));
    expect(diagnostics).toEqual([]);
    expect(spec!.nodes[0]!.spec!.nodes[0]!.type).toBe("function");
    expect(validateSpec(spec!).filter((d) => d.code === "UNKNOWN_NODE_TYPE")).toEqual([]);
  });

  it("names an unknown type inside an inline spec when another field fails to parse", async () => {
    const root = await write({
      "g.graph.yaml": [
        `${yamlHead}metadata: { name: g }`,
        "bogus: 1",
        "nodes:",
        "  - id: sub",
        "    type: subgraph",
        "    spec:",
        "      apiVersion: flowgraph/v1",
        "      kind: Graph",
        "      metadata: { name: child }",
        "      nodes:",
        "        - { id: x, type: shel }",
        "      edges: []",
        "edges: []",
        "",
      ].join("\n"),
    });
    const { diagnostics } = await loadGraph(path.join(root, "g.graph.yaml"));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "UNKNOWN_NODE_TYPE", path: "nodes.sub.spec.nodes.x.type" }));
  });
});
