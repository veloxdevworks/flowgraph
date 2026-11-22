import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { loadGraph, validateSpec } from "./loader.js";
import { REJECTED_TIME_ZONE_ABBREVIATIONS, TIME_ZONE_NAMES, cronScheduleProblem, isKnownTimeZone } from "./runtime/cron-schedule.js";
import { graphShapeDiagnostics, MAX_GRAPH_NESTING } from "./runtime/validate-graph.js";

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

  it("reports each hook problem inside a map body once, including a nested map", () => {
    const body = (hook: { on: string; do: string }) => ({
      type: "subgraph",
      spec: {
        ...head,
        metadata: { name: "item" },
        nodes: [{ id: "y", ...echo }],
        edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }],
        runtime: { hooks: [hook] },
      },
    });
    const hookReports = (diagnostics: Diagnostic[]) => diagnostics.filter((d) => /hook/i.test(`${d.code} ${d.path ?? ""} ${d.message}`));
    const cases = [
      { on: "node:before", do: "retry", path: "do", message: "Use allow, deny or interrupt." },
      { on: "node:after", do: "route:next", path: "do", message: "Use redact." },
      { on: "node:before", do: "ignore", path: "do", message: "Use allow, deny or interrupt." },
      { on: "intelligent:beforeStep", do: "allow", path: "on", message: 'Unknown hook event "intelligent:beforeStep".' },
    ];
    for (const hook of cases) {
      const found = hookReports(validateSpec(graph([mapOf(body(hook))])));
      expect(found, `${hook.on} ${hook.do}`).toEqual([
        expect.objectContaining({
          path: `nodes.m.with.node.spec.runtime.hooks[0].${hook.path}`,
          message: expect.stringContaining(hook.message),
        }),
      ]);
    }
    const nestedMap = hookReports(validateSpec(graph([
      mapOf({ type: "map", with: { over: "{{ item.xs }}", node: body({ on: "node:before", do: "retry" }) } }),
    ])));
    expect(nestedMap).toEqual([
      expect.objectContaining({
        path: "nodes.m.with.node.with.node.spec.runtime.hooks[0].do",
        message: expect.stringContaining("Use allow, deny or interrupt."),
      }),
    ]);
    const spec = graph([inline([{ id: "a", ...echo }])]);
    const nested = spec.nodes[0] as { spec: { runtime?: unknown } };
    nested.spec.runtime = { hooks: [{ on: "node:before", do: "retry" }] };
    expect(hookReports(validateSpec(spec))).toEqual([
      expect.objectContaining({
        path: "nodes.sub.spec.runtime.hooks[0].do",
        message: expect.stringContaining("Use allow, deny or interrupt."),
      }),
    ]);
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
  it("accepts every tzdata Zone and Link name, including UTC and GMT", () => {
    expect(TIME_ZONE_NAMES).toEqual(expect.arrayContaining(["UTC", "GMT", "Asia/Kathmandu", "Asia/Yangon", "Atlantic/Faroe", "America/Indiana/Indianapolis", "America/Kentucky/Louisville", "America/Argentina/Cordoba", "US/Eastern", "US/Pacific", "Canada/Eastern", "Australia/NSW", "Etc/Greenwich"]));
    for (const zone of TIME_ZONE_NAMES) expect(isKnownTimeZone(zone), zone).toBe(true);
  });

  it("rejects abbreviations and a different letter case", () => {
    for (const zone of REJECTED_TIME_ZONE_ABBREVIATIONS) {
      expect(TIME_ZONE_NAMES, zone).not.toContain(zone);
      expect(isKnownTimeZone(zone), zone).toBe(false);
    }
    for (const zone of ["Asia/KOLKATA", "US/MOUNTAIN", "Etc/Utc", "Europe/KYIV", "Asia/KATHMANDU", "america/denver", "AMERICA/DENVER", "America/DENVER", "utc", "gmt", " UTC", "", "+05:00", "Mars/Olympus"]) {
      expect(isKnownTimeZone(zone), zone).toBe(false);
    }
  });
});



describe("nesting depth", () => {
  function nestedTo(levels: number): GraphSpec {
    let spec = graph([{ id: "leaf", ...echo }]);
    for (let level = 1; level < levels; level++) spec = graph([inline(spec.nodes, spec.edges)]);
    return spec;
  }

  it(`accepts ${MAX_GRAPH_NESTING} levels and reports one more without throwing`, () => {
    expect(validateSpec(nestedTo(MAX_GRAPH_NESTING)).filter((d) => d.code === "GRAPH_NESTING_TOO_DEEP")).toEqual([]);
    const found = validateSpec(nestedTo(MAX_GRAPH_NESTING + 1));
    expect(found).toEqual([expect.objectContaining({ severity: "error", code: "GRAPH_NESTING_TOO_DEEP" })]);
    expect(found[0]!.path).toMatch(/^(nodes\.sub\.spec\.){31}nodes\.sub\.spec$/);
  });

  it("reports a programmatic inline spec that contains itself", async () => {
    const spec = graph([{ id: "sub", type: "subgraph" }]);
    (spec.nodes[0] as { spec?: unknown }).spec = spec;
    expect(validateSpec(spec)).toEqual([expect.objectContaining({ code: "GRAPH_NESTING_TOO_DEEP" })]);
    await expect(compileGraph(spec)).rejects.toMatchObject({ code: "GRAPH_NESTING_TOO_DEEP" });
  });

  it("reports a map body that contains itself", () => {
    const map = { id: "m", type: "map", with: { over: "{{ state.items }}" } as Record<string, unknown> };
    map.with.node = map;
    expect(validateSpec(graph([map]))).toEqual([expect.objectContaining({ code: "GRAPH_NESTING_TOO_DEEP" })]);
  });

  // Two nodes share each child spec, so there are 2^(levels-1) paths but only `levels` spec objects.
  function sharedTo(levels: number, leaf: Record<string, unknown> = echo): GraphSpec {
    let shared = graph([{ id: "leaf", ...leaf }]);
    for (let level = 1; level < levels; level++) {
      const child = { ...head, metadata: { name: `l${level}` }, nodes: shared.nodes, edges: shared.edges };
      shared = graph([
        { id: "a", type: "subgraph", spec: child },
        { id: "b", type: "subgraph", spec: child },
      ], { edges: [{ from: "START", to: "a" }, { from: "START", to: "b" }, { from: "a", to: "END" }, { from: "b", to: "END" }] });
    }
    return shared;
  }

  it("reports fan-out 2 at depth 30 as too large from one walk per object, in validate and compile", async () => {
    const spec = sharedTo(30);
    expect(validateSpec(spec)).toEqual([expect.objectContaining({ severity: "error", code: "GRAPH_TOO_LARGE", path: "nodes" })]);
    await expect(compileGraph(spec)).rejects.toMatchObject({ code: "GRAPH_TOO_LARGE" });
  });

  it("validates a shared spec within the limit at every place it is used", () => {
    const found = errors(validateSpec(sharedTo(4, { type: "shell", with: {} }))).filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(found).toHaveLength(8);
    expect(found.map((d) => d.path)).toContain("nodes.a.spec.nodes.b.spec.nodes.a.spec.nodes.leaf.with.command");
    // sharedTo(n) expands to 3 * 2^(n-1) - 2 nodes: 6142 at 12, 12286 at 13.
    expect(graphShapeDiagnostics(sharedTo(12))).toEqual([]);
    expect(graphShapeDiagnostics(sharedTo(13))).toEqual([expect.objectContaining({ code: "GRAPH_TOO_LARGE" })]);
  });

  it("reports nesting past the limit before size", () => {
    expect(graphShapeDiagnostics(sharedTo(40))).toEqual([expect.objectContaining({ code: "GRAPH_NESTING_TOO_DEEP" })]);
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
      "child.graph.yaml": `${yamlHead}metadata: { name: child }\nnodes:\n  - { id: p, type: acme/widget }\nedges:\n  - { from: START, to: p }\n  - { from: p, to: END }\n`,
    });
    const { diagnostics } = await loadGraph(path.join(root, "parent.graph.yaml"));
    expect(errors(diagnostics)).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", code: "PLUGIN_TYPE_UNRESOLVED", path: "nodes.p.type" }));
  });

  it("rejects removed pre-v1 type aliases inside inline subgraph specs", async () => {
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
    const { spec } = await loadGraph(path.join(root, "g.graph.yaml"));
    expect(spec!.nodes[0]!.spec!.nodes[0]!.type).toBe("code");
    expect(validateSpec(spec!).filter((d) => d.code === "UNKNOWN_NODE_TYPE")).toHaveLength(1);
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

const crashText = /startsWith|not iterable|TypeError|Unknown hook event "undefined"|trim is not a function|Cannot read properties/;

function nestedSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...head,
    metadata: { name: "item" },
    nodes: [{ id: "y", ...echo }],
    edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }],
    ...over,
  };
}

type ErrorRow = { code: string; path?: string; message: string };

/** validateSpec returns exactly these errors, and compileGraph throws the first code. */
async function expectExact(spec: GraphSpec, rows: ErrorRow[]): Promise<void> {
  let diagnostics: Diagnostic[] = [];
  expect(() => {
    diagnostics = validateSpec(spec);
  }).not.toThrow();
  expect(errors(diagnostics).map((d) => ({ code: d.code, ...(d.path ? { path: d.path } : {}), message: d.message }))).toEqual(rows);
  let thrown: unknown;
  try {
    await compileGraph(spec);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(TypeError);
  expect(thrown).toMatchObject({ code: rows[0]?.code });
  expect(String((thrown as Error).message)).not.toMatch(crashText);
}

describe("malformed nested graphs", () => {
  const body = "nodes.m.with.node.spec";

  it("reports each map-body problem once, with the schema diagnostic", async () => {
    const cases: Array<{ spec: Record<string, unknown>; path: string; message: string }> = [
      {
        spec: nestedSpec({ runtime: { hooks: [{ do: "allow" }] } }),
        path: `${body}.runtime.hooks.0.on`,
        message: "node.spec.runtime.hooks.0.on: Required",
      },
      {
        spec: nestedSpec({ runtime: { hooks: [{ on: "node:before" }] } }),
        path: `${body}.runtime.hooks.0.do`,
        message: "node.spec.runtime.hooks.0.do: Required",
      },
      {
        spec: nestedSpec({ runtime: { hooks: [{ on: "node:before", do: 5 }] } }),
        path: `${body}.runtime.hooks.0.do`,
        message: "node.spec.runtime.hooks.0.do: Expected string, received number",
      },
      {
        spec: nestedSpec({ runtime: { hooks: { on: "node:before", do: "allow" } } }),
        path: `${body}.runtime.hooks`,
        message: "node.spec.runtime.hooks: Expected array, received object",
      },
      {
        spec: (() => {
          const spec = nestedSpec();
          delete spec.edges;
          return spec;
        })(),
        path: `${body}.edges`,
        message: "node.spec.edges: Required",
      },
      {
        spec: nestedSpec({ edges: [{ from: 5, to: "y" }, { from: "y", to: "END" }] }),
        path: `${body}.edges.0`,
        message: "node.spec.edges.0: Invalid input",
      },
      {
        spec: nestedSpec({ edges: [{ from: "START", to: 5 }, { from: "y", to: "END" }] }),
        path: `${body}.edges.0`,
        message: "node.spec.edges.0: Invalid input",
      },
      {
        spec: nestedSpec({
          nodes: [{ ...echo, with: { command: "echo", args: ["hi"] } }],
          edges: [{ from: "START", to: "END" }],
        }),
        path: `${body}.nodes.0.id`,
        message: "node.spec.nodes.0.id: Required",
      },
      {
        spec: nestedSpec({ nodes: [{ id: "a", type: 5, with: {} }], edges: [{ from: "START", to: "a" }, { from: "a", to: "END" }] }),
        path: `${body}.nodes.0.type`,
        message: "node.spec.nodes.0.type: Expected string, received number",
      },
      {
        spec: nestedSpec({
          nodes: [{ id: "y", type: "router", with: { routes: 5 } }],
          edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }],
        }),
        path: `${body}.nodes.y.with.routes`,
        message: "routes: routes must be a list of - name: entries",
      },
    ];
    for (const item of cases) {
      await expectExact(graph([mapOf({ type: "subgraph", spec: item.spec })]), [
        { code: "NODE_CONFIG_ERROR", path: item.path, message: item.message },
      ]);
    }
  });

  it("reports an inline subgraph shape once, with a fitting code", async () => {
    const spec = "nodes.sub.spec";
    const cases: Array<{ spec: Record<string, unknown>; row: ErrorRow }> = [
      {
        spec: nestedSpec({ runtime: { hooks: [{ on: "node:before" }] } }),
        row: { code: "SCHEMA_ERROR", path: `${spec}.runtime.hooks[0].do`, message: "Required" },
      },
      {
        spec: nestedSpec({ runtime: { hooks: { on: "node:before", do: "allow" } } }),
        row: { code: "SCHEMA_ERROR", path: `${spec}.runtime.hooks`, message: "Expected array" },
      },
      {
        spec: nestedSpec({ edges: [{ from: 5, to: "y" }, { from: "y", to: "END" }] }),
        row: { code: "SCHEMA_ERROR", path: `${spec}.edges[0].from`, message: "Expected string" },
      },
      {
        spec: nestedSpec({
          nodes: [{ ...echo, with: { command: "echo", args: ["hi"] } }],
          edges: [{ from: "START", to: "END" }],
        }),
        row: { code: "SCHEMA_ERROR", path: `${spec}.nodes[0].id`, message: "Required" },
      },
      {
        spec: nestedSpec({ nodes: [{ id: "y", type: 5, with: {} }], edges: [{ from: "START", to: "END" }] }),
        row: { code: "SCHEMA_ERROR", path: `${spec}.nodes[0].type`, message: "Expected string" },
      },
      {
        spec: nestedSpec({
          nodes: [{ id: "y", type: "router", with: { routes: 5 } }],
          edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }],
        }),
        row: {
          code: "NODE_CONFIG_ERROR",
          path: `${spec}.nodes.y.with.routes`,
          message: "routes: routes must be a list of - name: entries",
        },
      },
    ];
    for (const item of cases) {
      await expectExact(graph([{ id: "sub", type: "subgraph", spec: item.spec }]), [item.row]);
    }
  });

  it("never throws a non-coded error for a fixed list of malformed graphs", async () => {
    const places = ["top", "map", "nested map", "inline"] as const;
    const broken = (): Record<string, unknown> => ({
      ...head,
      metadata: { name: "g" },
      nodes: [{ id: "r", type: "router", with: { routes: [{ name: "go", when: 5 }, { name: "else", default: true }] } }, { id: "y", ...echo }],
      edges: [
        { from: "START", to: "r" },
        { from: "r", branch: [{ to: "y", when: 5 }, { to: "END", default: true }] },
        { from: "y", to: "END" },
      ],
    });
    const defects: Array<{ name: string; spec: () => Record<string, unknown> }> = [
      { name: "null node", spec: () => ({ ...head, metadata: { name: "g" }, nodes: [null, { id: "y", ...echo }], edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }] }) },
      { name: "nodes object", spec: () => ({ ...head, metadata: { name: "g" }, nodes: { y: { id: "y", ...echo } }, edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }] }) },
      { name: "router when", spec: broken },
      { name: "branch when", spec: () => ({ ...head, metadata: { name: "g" }, nodes: [{ id: "y", ...echo }], edges: [{ from: "START", branch: [{ to: "y", when: 5 }, { to: "END", default: true }] }, { from: "y", to: "END" }] }) },
      { name: "null trigger", spec: () => ({ ...head, metadata: { name: "g" }, nodes: [{ id: "y", ...echo }], edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }], triggers: [null] }) },
      { name: "cron schedule", spec: () => ({ ...head, metadata: { name: "g" }, nodes: [{ id: "y", ...echo }], edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }], triggers: [{ id: "t", type: "cron", schedule: 5 }] }) },
      { name: "null input", spec: () => ({ ...head, metadata: { name: "g" }, nodes: [{ id: "y", ...echo }], edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }], inputs: [null] }) },
      { name: "null channel", spec: () => ({ ...head, metadata: { name: "g" }, nodes: [{ id: "y", ...echo }], edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }], state: { channels: { out: null } } }) },
      { name: "reducer type", spec: () => ({ ...head, metadata: { name: "g" }, nodes: [{ id: "y", ...echo }], edges: [{ from: "START", to: "y" }, { from: "y", to: "END" }], state: { channels: { out: { type: "string", reducer: 5 } } } }) },
    ];
    const place = (kind: (typeof places)[number], inner: Record<string, unknown>): GraphSpec => {
      if (kind === "top") return inner as GraphSpec;
      if (kind === "map") return graph([mapOf({ type: "subgraph", spec: inner })]);
      if (kind === "nested map") {
        return graph([mapOf({
          type: "map",
          with: { over: "{{ item.xs }}", node: { type: "subgraph", spec: inner } },
        })]);
      }
      return graph([{ id: "sub", type: "subgraph", spec: inner }]);
    };
    for (const kind of places) {
      for (const defect of defects) {
        const spec = place(kind, defect.spec());
        let diagnostics: Diagnostic[] = [];
        expect(() => {
          diagnostics = validateSpec(spec);
        }, `${kind} ${defect.name}`).not.toThrow();
        expect(errors(diagnostics).length, `${kind} ${defect.name}`).toBeGreaterThan(0);
        expect(errors(diagnostics).every((d) => /^[A-Z0-9_]+$/.test(d.code) && !crashText.test(d.message)), `${kind} ${defect.name}`).toBe(true);
        let thrown: unknown;
        try {
          await compileGraph(spec);
        } catch (err) {
          thrown = err;
        }
        if (thrown !== undefined) {
          expect(thrown, `${kind} ${defect.name}`).toBeInstanceOf(Error);
          expect(thrown, `${kind} ${defect.name}`).not.toBeInstanceOf(TypeError);
          expect((thrown as { code?: string }).code, `${kind} ${defect.name}`).toMatch(/^[A-Z0-9_]+$/);
          expect(String((thrown as Error).message), `${kind} ${defect.name}`).not.toMatch(crashText);
        }
      }
    }
  });
});
