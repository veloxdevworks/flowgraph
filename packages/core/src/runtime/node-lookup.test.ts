import { describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { validateSpec } from "../loader.js";
import { declaredRouteTargets, graphEdges } from "./validate-graph.js";

const head = { apiVersion: "flowgraph/v1", kind: "Graph" } as const;

function shell(id: string): GraphSpec["nodes"][number] {
  return { id, type: "shell", with: { command: "echo", args: [id] } } as GraphSpec["nodes"][number];
}

describe("node lookup", () => {
  it("reads a router replaced in place on the next validation", () => {
    const spec: GraphSpec = {
      ...head,
      metadata: { name: "g" },
      nodes: [
        {
          id: "r",
          type: "router",
          with: {
            routes: [
              { name: "left", when: "true", to: "a" },
              { name: "right", default: true, to: "b" },
            ],
          },
        } as GraphSpec["nodes"][number],
        shell("a"),
        shell("b"),
      ],
      edges: [
        { from: "START", to: "r" },
        { from: "a", to: "END" },
        { from: "b", to: "END" },
      ],
    };
    validateSpec(spec);
    const index = spec.nodes.findIndex((node) => node.id === "r");
    spec.nodes[index] = shell("r");
    const fresh = structuredClone(spec);

    expect(validateSpec(spec)).toEqual(validateSpec(fresh));
    expect(graphEdges(spec)).toEqual(graphEdges(fresh));
    expect(validateSpec(spec).filter((d) => d.code === "UNREACHABLE_FROM_START")).toEqual([
      { severity: "error", code: "UNREACHABLE_FROM_START", message: 'Node "a" is not reachable from START', path: "nodes.a" },
      { severity: "error", code: "UNREACHABLE_FROM_START", message: 'Node "b" is not reachable from START', path: "nodes.b" },
    ]);
    expect(graphEdges(spec)).toEqual([
      { from: "START", to: "r" },
      { from: "a", to: "END" },
      { from: "b", to: "END" },
    ]);
  });

  it("keeps the first node of a repeated id, including a later terminal node", () => {
    const nodes = [
      shell("a"),
      { id: "a", type: "fail", with: { reason: "stop" } } as GraphSpec["nodes"][number],
      shell("b"),
    ];
    const edges = [{ from: "START", to: "b" }, { from: "b", to: "a" }] as GraphSpec["edges"];
    const top: GraphSpec = { ...head, metadata: { name: "g" }, nodes, edges };
    expect(validateSpec(top)).toEqual([
      { severity: "error", code: "DUPLICATE_NODE_ID", message: 'Duplicate node id: "a"' },
    ]);

    const nested: GraphSpec = {
      ...head,
      metadata: { name: "g" },
      nodes: [{
        id: "m",
        type: "map",
        with: {
          over: "{{ state.items }}",
          node: {
            type: "subgraph",
            spec: { ...head, metadata: { name: "child" }, nodes, edges },
          },
        },
      } as GraphSpec["nodes"][number]],
      edges: [{ from: "START", to: "m" }, { from: "m", to: "END" }],
    };
    expect(validateSpec(nested)).toEqual([
      { severity: "error", code: "DUPLICATE_NODE_ID", message: 'Duplicate node id: "a"', path: "nodes.m.with.node.spec.nodes.a" },
    ]);
  });

  it("resolves a repeated id to the first node", () => {
    const router = {
      id: "a",
      type: "router",
      with: { routes: [{ name: "go", default: true, to: "b" }] },
    } as GraphSpec["nodes"][number];
    const spec = (nodes: GraphSpec["nodes"]): GraphSpec => ({
      ...head,
      metadata: { name: "g" },
      nodes,
      edges: [{ from: "START", to: "a" }, { from: "b", to: "END" }],
    });
    expect(declaredRouteTargets(spec([router, shell("a"), shell("b")]), "a")).toEqual(["b"]);
    expect(declaredRouteTargets(spec([shell("a"), router, shell("b")]), "a")).toEqual([]);
  });
});
