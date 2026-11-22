import { describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { validateSpec } from "../loader.js";
import { graphEdges } from "./validate-graph.js";

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
});
