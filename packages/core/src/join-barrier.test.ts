import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
import { registerFunction } from "./nodes/function.js";

const calls: string[] = [];

registerFunction("joinBarrierMark", (input) => {
  const id = String((input as { id?: string }).id ?? "");
  calls.push(id);
  return id;
});

beforeEach(() => {
  calls.length = 0;
});

function mark(id: string) {
  return {
    id,
    type: "function",
    with: { fn: "joinBarrierMark", input: { id }, output: { to: "seen", raw: false } },
  };
}

function graph(
  edges: GraphSpec["edges"],
  name = "join-barrier",
  ids = ["split", "short", "mid", "long", "join"],
): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name },
    state: { channels: { seen: { type: "array", reducer: "append" } } },
    nodes: ids.map(mark),
    edges,
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

const unevenEdges = {
  plain: [
    { from: "START", to: "split" },
    { from: "split", to: ["short", "mid"] },
    { from: "short", to: "join" },
    { from: "mid", to: "long" },
    { from: "long", to: "join" },
    { from: "join", to: "END" },
  ],
  barrier: [
    { from: "START", to: "split" },
    { from: "split", to: ["short", "mid"] },
    { from: "mid", to: "long" },
    { from: ["short", "long"], to: "join" },
    { from: "join", to: "END" },
  ],
} satisfies Record<string, GraphSpec["edges"]>;

const evenEdges: GraphSpec["edges"] = [
  { from: "START", to: "split" },
  { from: "split", to: ["short", "mid"] },
  { from: "short", to: "join" },
  { from: "mid", to: "join" },
  { from: "join", to: "END" },
];

async function seenOf(spec: GraphSpec): Promise<string[]> {
  const compiled = await compileGraph(spec, {});
  const result = await compiled.run({ input: {} });
  expect(result.status).toBe("completed");
  return result.state["seen"] as string[];
}

function joinCount(seen: string[]): number {
  return seen.filter((id) => id === "join").length;
}

describe("join barrier", () => {
  it("runs an uneven join twice without a barrier and once with one", async () => {
    const plain = graph(unevenEdges.plain, "uneven-plain");
    const barrier = graph(unevenEdges.barrier, "uneven-barrier");

    expect(
      validateSpec(plain).some((d) => d.code === "UNEVEN_FAN_IN" && d.severity === "warning"),
    ).toBe(true);
    expect(validateSpec(barrier).some((d) => d.code === "UNEVEN_FAN_IN")).toBe(false);
    expect(validateSpec(barrier).filter((d) => d.severity === "error")).toEqual([]);

    const plainSeen = await seenOf(plain);
    expect(joinCount(plainSeen)).toBe(2);
    expect(calls.filter((id) => id === "join")).toHaveLength(2);
    expect(plainSeen).toEqual(expect.arrayContaining(["short", "long"]));

    calls.length = 0;
    const barrierSeen = await seenOf(barrier);
    expect(joinCount(barrierSeen)).toBe(1);
    expect(calls.filter((id) => id === "join")).toHaveLength(1);
    expect(barrierSeen).toEqual(expect.arrayContaining(["short", "long"]));
  });

  it("keeps a single run for equal-length branches without a barrier", async () => {
    const spec = graph(evenEdges, "even-plain", ["split", "short", "mid", "join"]);
    expect(validateSpec(spec).some((d) => d.code === "UNEVEN_FAN_IN")).toBe(false);
    const seen = await seenOf(spec);
    expect(joinCount(seen)).toBe(1);
    expect(seen).toEqual(expect.arrayContaining(["short", "mid"]));
  });

  it("does not warn when a second inbound edge is a loop back to an earlier node", () => {
    const spec = graph(
      [
        { from: "START", to: "split" },
        { from: "split", to: "short" },
        { from: "short", to: "split" },
        { from: "split", to: "END" },
      ],
      "loop-head",
      ["split", "short"],
    );
    expect(validateSpec(spec).some((d) => d.code === "UNEVEN_FAN_IN")).toBe(false);
  });

  it("rejects a barrier source that is only reachable through a conditional branch", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "barrier-conditional" },
      nodes: ["choose", "left", "right", "join"].map(mark),
      edges: [
        { from: "START", to: "choose" },
        {
          from: "choose",
          branch: [
            { when: "{{ true }}", to: "left" },
            { default: true, to: "right" },
          ],
        },
        { from: ["left", "right"], to: "join" },
        { from: "join", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    const diags = validateSpec(spec).filter((d) => d.code === "BARRIER_CONDITIONAL_SOURCE");
    expect(diags.map((d) => d.message).sort()).toEqual([
      expect.stringContaining('"left"'),
      expect.stringContaining('"right"'),
    ]);
    expect(
      diags.every((d) => d.severity === "error" && d.message.includes("conditional branch")),
    ).toBe(true);

    await expect(compileGraph(spec, {})).rejects.toMatchObject({
      code: "BARRIER_CONDITIONAL_SOURCE",
    });
  });

  it("rejects unknown ids, duplicates, START, and a barrier aimed at END", () => {
    const unknown = graph([
      { from: "START", to: "split" },
      { from: ["short", "missing"], to: "join" },
      { from: "join", to: "END" },
    ]);
    const duplicate = graph([
      { from: "START", to: "split" },
      { from: ["short", "short"], to: "join" },
      { from: "join", to: "END" },
    ]);
    const reserved = graph([
      { from: "START", to: "split" },
      { from: ["START", "short"], to: "join" },
      { from: "join", to: "END" },
    ]);
    const toEnd = graph([
      { from: "START", to: "split" },
      { from: ["short", "long"], to: "END" },
    ]);

    expect(validateSpec(unknown).filter((d) => d.code === "UNKNOWN_NODE_REF")).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining('"missing"') }),
    ]);
    expect(
      validateSpec(duplicate).some(
        (d) => d.code === "DUPLICATE_EDGE_SOURCE" && d.message.includes('"short"'),
      ),
    ).toBe(true);
    expect(
      validateSpec(reserved).some(
        (d) => d.code === "BARRIER_SOURCE_INVALID" && d.message.includes("START"),
      ),
    ).toBe(true);
    expect(validateSpec(toEnd).some((d) => d.code === "BARRIER_TARGET_END")).toBe(true);
  });

  it("parses the uneven-join example", () => {
    const file = resolve(
      import.meta.dirname,
      "../../../examples/join-barrier/uneven-join.graph.yaml",
    );
    const spec = GraphSpecSchema.parse(parse(readFileSync(file, "utf8")));
    expect(spec.edges).toContainEqual({ from: ["short", "long"], to: "join" });
    expect(validateSpec(spec).filter((d) => d.severity === "error")).toEqual([]);
  });
});
