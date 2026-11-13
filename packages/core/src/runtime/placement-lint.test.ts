import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { loadGraph } from "../loader.js";
import { placementAdjacentHopDiagnostics, placementDiagnostics, graphLintDiagnostics } from "./validate-graph.js";

const g = (nodes: unknown[], edges: unknown[] = []) =>
  ({ metadata: { name: "p" }, state: { channels: {} }, nodes, edges }) as unknown as GraphSpec;
const sh = (id: string, runsOn?: unknown) => ({ id, type: "shell", with: { command: "true" }, ...(runsOn ? { runsOn } : {}) });

describe("placementDiagnostics", () => {
  it("rejects runsOn on hitl, workshop and wait", () => {
    for (const type of ["hitl", "workshop", "wait"]) {
      const d = placementDiagnostics(g([{ id: "x", type, runsOn: ["os:linux"] }]));
      expect(d.map((x) => x.code), type).toEqual(["PLACEMENT_NOT_ALLOWED"]);
      expect(d[0]!.severity).toBe("error");
      expect(d[0]!.message).toContain("forwarded");
    }
  });

  it("allows gates without runsOn inside a placed inline subgraph, with a phase-2 warning", () => {
    const child = g([{ id: "ask", type: "hitl" }, sh("a")]);
    const d = placementDiagnostics(g([{ id: "sg", type: "subgraph", spec: child, runsOn: ["os:windows"] }]));
    expect(d.map((x) => [x.severity, x.code])).toEqual([["warning", "PLACEMENT_GATE_PHASE2"]]);
  });

  it("warns PLACEMENT_GATE_PHASE2 for workshop, wait on until/signal/webhook, ask_human, and gates in a map inner", () => {
    const placed = (inner: unknown) => placementDiagnostics(g([{ id: "sg", type: "subgraph", spec: g([inner]), runsOn: ["os:linux"] }]));
    const codes = (d: Array<{ code: string }>) => d.map((x) => x.code);
    expect(codes(placed({ id: "w", type: "workshop" }))).toEqual(["PLACEMENT_GATE_PHASE2"]);
    for (const k of ["until", "signal", "webhook"]) {
      expect(codes(placed({ id: "w", type: "wait", with: { [k]: "x" } })), k).toEqual(["PLACEMENT_GATE_PHASE2"]);
    }
    expect(codes(placed({ id: "w", type: "wait", with: { duration: "1s" } }))).toEqual([]);
    expect(codes(placed({ id: "a", type: "agent", with: { tools: [{ function: "ask_human" }] } }))).toEqual(["PLACEMENT_GATE_PHASE2"]);
    expect(codes(placed({ id: "a", type: "agent", with: { tools: [] } }))).toEqual([]);
    expect(codes(placed({ id: "m", type: "map", with: { node: { id: "g", type: "hitl" } } }))).toEqual(["PLACEMENT_GATE_PHASE2"]);
    // an unplaced subgraph with a gate is fine
    expect(placementDiagnostics(g([{ id: "sg", type: "subgraph", spec: g([{ id: "ask", type: "hitl" }]) }]))).toEqual([]);
  });

  it("flags a placed inline subgraph containing runsOn, at any depth", () => {
    const deep = g([{ id: "mid", type: "subgraph", spec: g([sh("leaf", ["os:linux"])]) }]);
    const d = placementDiagnostics(g([{ id: "sg", type: "subgraph", spec: deep, runsOn: ["os:windows"] }]));
    expect(d.map((x) => x.code)).toEqual(["PLACEMENT_NESTED"]);
    expect(d[0]!.path).toBe("nodes.sg.runsOn");
  });

  it("rejects runsOn inside an unplaced subgraph or map inner, since only top-level nodes are placed", () => {
    const d = placementDiagnostics(g([{ id: "sg", type: "subgraph", spec: g([sh("leaf", ["os:linux"])]) }]));
    expect(d.map((x) => x.code)).toEqual(["PLACEMENT_NOT_TOP_LEVEL"]);
    expect(d[0]!.path).toBe("nodes.sg.spec.nodes.leaf.runsOn");
    expect(d[0]!.message).toContain("would be ignored");

    const deep = g([{ id: "mid", type: "subgraph", spec: g([sh("leaf", ["os:linux"])]) }]);
    expect(placementDiagnostics(g([{ id: "sg", type: "subgraph", spec: deep }])).map((x) => x.code)).toEqual([
      "PLACEMENT_NOT_TOP_LEVEL",
    ]);

    const inMap = placementDiagnostics(g([{ id: "m", type: "map", with: { over: "{{ state.xs }}", node: sh("item", ["os:linux"]) } }]));
    expect(inMap.map((x) => x.code)).toEqual(["PLACEMENT_NOT_TOP_LEVEL"]);
  });

  it("does not add PLACEMENT_NOT_TOP_LEVEL under a placed ancestor (PLACEMENT_NESTED covers it)", () => {
    const d = placementDiagnostics(g([{ id: "sg", type: "subgraph", spec: g([sh("leaf", ["os:linux"])]), runsOn: ["os:windows"] }]));
    expect(d.map((x) => x.code)).toEqual(["PLACEMENT_NESTED"]);
  });

  it("is included in graphLintDiagnostics", () => {
    const d = graphLintDiagnostics(g([{ id: "x", type: "wait", runsOn: ["os:linux"] }]));
    expect(d.some((x) => x.code === "PLACEMENT_NOT_ALLOWED")).toBe(true);
  });
});

describe("placementAdjacentHopDiagnostics", () => {
  const edges = [{ from: "START", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "END" }];

  it("warns when adjacent nodes share labels (as a set) and target", () => {
    const d = placementAdjacentHopDiagnostics(
      g([sh("a", ["os:windows", "app:cc5"]), sh("b", { labels: ["app:cc5", "os:windows"], fallback: "local" })], edges),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "warning", code: "PLACEMENT_ADJACENT_HOPS", path: "edges[1]" });
    expect(d[0]!.message).toContain("subgraph");
  });

  it("does not warn for different labels, different targets, or an unplaced neighbour", () => {
    expect(placementAdjacentHopDiagnostics(g([sh("a", ["os:windows"]), sh("b", ["os:linux"])], edges))).toEqual([]);
    expect(
      placementAdjacentHopDiagnostics(
        g([sh("a", { labels: ["os:linux"], target: "x" }), sh("b", { labels: ["os:linux"], target: "y" })], edges),
      ),
    ).toEqual([]);
    expect(
      placementAdjacentHopDiagnostics(g([sh("a", { labels: ["os:linux"], target: "x" }), sh("b", ["os:linux"])], edges)),
    ).toEqual([]);
    expect(placementAdjacentHopDiagnostics(g([sh("a", ["os:linux"]), sh("b")], edges))).toEqual([]);
  });

  it("ignores conditional edges", () => {
    const d = placementAdjacentHopDiagnostics(
      g([sh("a", ["os:linux"]), sh("b", ["os:linux"])], [{ from: "a", branch: [{ to: "b", default: true }] }]),
    );
    expect(d).toEqual([]);
  });
});

describe("loadGraph: PLACEMENT_NESTED through uses:", () => {
  const wrap = (nodes: string) =>
    `apiVersion: flowgraph/v1\nkind: Graph\nmetadata: { name: t }\nstate: { channels: {} }\nnodes:\n${nodes}\nedges:\n  - { from: START, to: END }\n`;

  it("flags a placed subgraph whose file child (or grandchild) uses runsOn", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-placement-"));
    await fs.writeFile(path.join(dir, "leaf.yaml"), wrap(`  - { id: l, type: shell, runsOn: [os:linux], with: { command: "true" } }`));
    await fs.writeFile(path.join(dir, "mid.yaml"), wrap(`  - { id: m, type: subgraph, uses: ./leaf.yaml }`));
    await fs.writeFile(path.join(dir, "clean.yaml"), wrap(`  - { id: c, type: shell, with: { command: "true" } }`));
    for (const [child, expected] of [["leaf.yaml", true], ["mid.yaml", true], ["clean.yaml", false]] as const) {
      const file = path.join(dir, `parent-${child}`);
      await fs.writeFile(file, wrap(`  - { id: p, type: subgraph, uses: ./${child}, runsOn: [os:windows] }`));
      const r = await loadGraph(file);
      expect(r.diagnostics.some((d) => d.code === "PLACEMENT_NESTED"), child).toBe(expected);
    }
  });

  it("rejects an unplaced subgraph whose file child sets runsOn (PLACEMENT_NOT_TOP_LEVEL), not PLACEMENT_NESTED", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-placement-"));
    await fs.writeFile(path.join(dir, "leaf.yaml"), wrap(`  - { id: l, type: shell, runsOn: [os:linux], with: { command: "true" } }`));
    await fs.writeFile(path.join(dir, "clean.yaml"), wrap(`  - { id: c, type: shell, with: { command: "true" } }`));
    const file = path.join(dir, "parent.yaml");
    await fs.writeFile(file, wrap(`  - { id: p, type: subgraph, uses: ./leaf.yaml }`));
    const r = await loadGraph(file);
    expect(r.diagnostics.some((d) => d.code === "PLACEMENT_NESTED")).toBe(false);
    const notTop = r.diagnostics.filter((d) => d.code === "PLACEMENT_NOT_TOP_LEVEL");
    expect(notTop).toHaveLength(1);
    expect(notTop[0]).toMatchObject({ severity: "error", path: "nodes.p.uses" });

    const cleanFile = path.join(dir, "parent-clean.yaml");
    await fs.writeFile(cleanFile, wrap(`  - { id: p, type: subgraph, uses: ./clean.yaml }`));
    expect((await loadGraph(cleanFile)).diagnostics.some((d) => d.code === "PLACEMENT_NOT_TOP_LEVEL")).toBe(false);
  });
});

describe("placed non-subgraph nodes", () => {
  const fn = (extra: Record<string, unknown>) => ({ id: "f", type: "function", runsOn: ["os:linux"], ...extra });
  const codes = (n: unknown) => placementDiagnostics(g([n])).map((x) => x.code);

  it("PLACEMENT_STATE_REFERENCE: a with template reading state is an error naming node, path and the fix", () => {
    const d = placementDiagnostics(g([fn({ with: { fn: "x", input: { v: "{{ state.topic.name }}" } } })]));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", code: "PLACEMENT_STATE_REFERENCE", path: "nodes.f.with.input.v" });
    expect(d[0]!.message).toContain('"f"');
    expect(d[0]!.message).toContain("state.topic.name");
    expect(d[0]!.message).toMatch(/input:.*stateMap\.in/s);
  });

  it("also catches config, computed state indexes and refs inside expressions or arrays", () => {
    expect(codes(fn({ with: { args: ["a {{ config.vars.x }}"] } }))).toEqual(["PLACEMENT_STATE_REFERENCE"]);
    expect(codes(fn({ with: { v: "{{ input.k ?? state.fallback }}" } }))).toEqual(["PLACEMENT_STATE_REFERENCE"]);
    expect(codes(fn({ with: { v: "{{ input[state.key] }}" } }))).toEqual(["PLACEMENT_STATE_REFERENCE"]);
  });

  it("the same value passed through input is fine, as are output mapping, when and node input", () => {
    expect(
      codes(
        fn({
          when: "{{ state.go }}",
          input: { v: "{{ state.topic }}" },
          with: { fn: "x", input: { v: "{{ input.v }}", e: "{{ env.HOME }}", r: "{{ run.threadId }}" }, output: { to: "out", map: { m: "{{ state.a }}" } } },
        }),
      ),
    ).toEqual([]);
  });

  it("does not check subgraph nodes here", () => {
    const child = g([{ id: "a", type: "function", with: { v: "{{ state.inner }}" } }]);
    expect(codes({ id: "sg", type: "subgraph", spec: child, runsOn: ["os:linux"], with: { stateMap: { in: { x: "{{ state.y }}" } } } })).toEqual([]);
  });

  it("does not check unplaced nodes", () => {
    expect(codes({ id: "f", type: "function", with: { v: "{{ state.x }}" } })).toEqual([]);
  });

  it("PLACEMENT_INPUT_ID_COLLISION: an input key equal to the node id", () => {
    const d = placementDiagnostics(g([fn({ input: { f: "{{ state.x }}" } })]));
    expect(d.map((x) => x.code)).toEqual(["PLACEMENT_INPUT_ID_COLLISION"]);
    expect(d[0]!.severity).toBe("error");
    expect(d[0]!.message).toContain('"f"');
  });

  it("PLACEMENT_NOT_SUPPORTED: map and router with runsOn are errors", () => {
    for (const type of ["map", "router"]) {
      const d = placementDiagnostics(g([{ id: "x", type, runsOn: ["os:linux"] }]));
      expect(d.map((x) => x.code), type).toEqual(["PLACEMENT_NOT_SUPPORTED"]);
      expect(d[0]!.message).toContain("subgraph");
    }
    expect(placementDiagnostics(g([{ id: "x", type: "map" }]))).toEqual([]);
  });
});

