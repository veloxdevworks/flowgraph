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

registerFunction("joinBarrierFail", () => {
  throw new Error("expected failure");
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

/** START fans out to e and z, and both must finish before join. */
function recoveryBarrier(source: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "barrier-recovery-source" },
    state: { channels: { seen: { type: "array", reducer: "append" }, items: { type: "array" } } },
    nodes: [source, mark("z"), mark("join"), mark("rec")],
    edges: [
      { from: "START", to: ["e", "z"] },
      { from: ["e", "z"], to: "join" },
      { from: "join", to: "END" },
      { from: "rec", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

async function expectRecoverySource(spec: GraphSpec, id: string): Promise<void> {
  const diags = validateSpec(spec).filter((d) => d.code === "BARRIER_RECOVERY_SOURCE");
  expect(diags.map((d) => d.message)).toEqual([expect.stringContaining(`"${id}"`)]);
  expect(diags.every((d) => d.severity === "error" && d.message.includes('"rec"'))).toBe(true);
  await expect(compileGraph(spec, {})).rejects.toMatchObject({ code: "BARRIER_RECOVERY_SOURCE" });
}

/** `x` is listed on a barrier, but the only edges that name it leave a route-declaring node. */
function routeSpec(kind: "router" | "hitl"): GraphSpec {
  const gate =
    kind === "router"
      ? {
          id: "gate",
          type: "router",
          with: {
            mode: "rules",
            routes: {
              go: { default: true, to: "x" },
              other: { when: "{{ false }}", to: "y" },
            },
          },
        }
      : {
          id: "gate",
          type: "hitl",
          with: {
            mode: "choice",
            message: "Which way?",
            choices: ["x", "y"],
            routes: { x: "x", y: "y" },
          },
        };
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: `barrier-${kind}-route` },
    state: { channels: { seen: { type: "array", reducer: "append" } } },
    nodes: [gate, mark("x"), mark("y"), mark("z"), mark("join")],
    edges: [
      { from: "START", to: "gate" },
      { from: "START", to: "z" },
      { from: "gate", to: ["x", "y"] },
      { from: ["x", "z"], to: "join" },
      { from: "y", to: "END" },
      { from: "join", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

/**
 * Exclusive routes of different lengths that both draw a plain edge to `join`.
 * Only one route runs, so this is not an uneven parallel fan-in.
 */
function exclusiveSpec(kind: "router" | "hitl"): GraphSpec {
  const gate =
    kind === "router"
      ? {
          id: "gate",
          type: "router",
          with: { mode: "rules", routes: { only: { default: true, to: "short" } } },
        }
      : {
          id: "gate",
          type: "hitl",
          with: {
            mode: "approve",
            message: "Go?",
            routes: { approved: "short", rejected: "long" },
          },
        };
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: `exclusive-${kind}` },
    nodes: [gate, mark("short"), mark("mid"), mark("long"), mark("join")],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "short" },
      { from: "gate", to: "mid" },
      { from: "mid", to: "long" },
      { from: "short", to: "join" },
      { from: "long", to: "join" },
      { from: "join", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
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

  it("rejects unknown ids, duplicates, START, END, a self-target, and a barrier aimed at END", async () => {
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

    const endSource = graph([
      { from: "START", to: "split" },
      { from: ["END", "short"], to: "join" },
      { from: "join", to: "END" },
    ]);
    expect(
      validateSpec(endSource).some(
        (d) =>
          d.code === "BARRIER_SOURCE_INVALID" &&
          d.severity === "error" &&
          d.message.includes('"END"') &&
          d.message.includes("cannot be a barrier source"),
      ),
    ).toBe(true);

    const self = graph([
      { from: "START", to: "split" },
      { from: ["join", "short"], to: "join" },
      { from: "join", to: "END" },
    ]);
    const selfInList = graph([
      { from: "START", to: "split" },
      { from: ["short", "long"], to: ["join", "short"] },
      { from: "join", to: "END" },
    ]);
    expect(
      validateSpec(self).some(
        (d) => d.code === "BARRIER_SELF_SOURCE" && d.message.includes('"join"'),
      ),
    ).toBe(true);
    expect(
      validateSpec(selfInList).some(
        (d) => d.code === "BARRIER_SELF_SOURCE" && d.message.includes('"short"'),
      ),
    ).toBe(true);
    await expect(compileGraph(self, {})).rejects.toMatchObject({ code: "BARRIER_SELF_SOURCE" });
  });

  it("does not fire the barrier again when a loop reruns only one source", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "barrier-loop" },
      state: { channels: { seen: { type: "array", reducer: "append" } } },
      nodes: ["split", "left", "right", "join", "park", "finish"].map(mark),
      edges: [
        { from: "START", to: "split" },
        { from: "split", to: ["left", "right"] },
        { from: ["left", "right"], to: "join" },
        { from: "join", to: "left" },
        {
          from: "left",
          branch: [
            { when: "{{ includes(state.seen, 'join') }}", to: "finish" },
            { default: true, to: "park" },
          ],
        },
        { from: "finish", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    expect(validateSpec(spec).filter((d) => d.severity === "error")).toEqual([]);
    const seen = await seenOf(spec);
    expect(seen.filter((id) => id === "left")).toHaveLength(2);
    expect(seen.filter((id) => id === "right")).toHaveLength(1);
    expect(joinCount(seen)).toBe(1);
    expect(seen.filter((id) => id === "finish")).toHaveLength(1);
  });

  it("runs the join once after a hitl barrier source resumes", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "barrier-hitl-resume" },
      state: { channels: { seen: { type: "array", reducer: "append" } } },
      nodes: [
        mark("left"),
        { id: "ask", type: "hitl", with: { mode: "approve", message: "Continue?" } },
        mark("join"),
      ],
      edges: [
        { from: "START", to: "left" },
        { from: "left", to: "ask" },
        { from: ["left", "ask"], to: "join" },
        { from: "join", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    expect(validateSpec(spec).filter((d) => d.severity === "error")).toEqual([]);
    const compiled = await compileGraph(spec, {});
    const paused = await compiled.run({ threadId: "barrier-hitl-resume", onInterrupt: "fail" });
    expect(paused.status).toBe("interrupted");
    expect(joinCount((paused.state["seen"] as string[]) ?? [])).toBe(0);

    const resumed = await compiled.resume({
      threadId: "barrier-hitl-resume",
      resume: { approved: true },
      onInterrupt: "fail",
    });
    expect(resumed.status).toBe("completed");
    const seen = resumed.state["seen"] as string[];
    expect(seen.filter((id) => id === "left")).toHaveLength(1);
    expect(joinCount(seen)).toBe(1);
  });

  it("rejects barrier sources that only a router or a hitl route can reach", async () => {
    const router = routeSpec("router");
    const hitl = routeSpec("hitl");
    for (const spec of [router, hitl]) {
      const diags = validateSpec(spec).filter((d) => d.code === "BARRIER_CONDITIONAL_SOURCE");
      expect(diags.map((d) => d.message)).toEqual([expect.stringContaining('"x"')]);
      expect(diags.every((d) => d.severity === "error" && d.message.includes("declared route"))).toBe(
        true,
      );
      await expect(compileGraph(spec, {})).rejects.toMatchObject({
        code: "BARRIER_CONDITIONAL_SOURCE",
      });
    }
  });

  it("does not warn about uneven fan-in on exclusive router or hitl routes", () => {
    expect(validateSpec(exclusiveSpec("router")).some((d) => d.code === "UNEVEN_FAN_IN")).toBe(false);
    expect(validateSpec(exclusiveSpec("hitl")).some((d) => d.code === "UNEVEN_FAN_IN")).toBe(false);
  });

  it("runs the join once when a router node is itself a barrier source", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "barrier-router-source" },
      state: { channels: { seen: { type: "array", reducer: "append" } } },
      nodes: [
        {
          id: "route",
          type: "router",
          with: { mode: "rules", routes: { go: { default: true, to: "done" } } },
        },
        mark("side"),
        mark("done"),
        mark("join"),
      ],
      edges: [
        { from: "START", to: "route" },
        { from: "START", to: "side" },
        { from: ["route", "side"], to: "join" },
        { from: "done", to: "END" },
        { from: "join", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    expect(validateSpec(spec).filter((d) => d.severity === "error")).toEqual([]);
    const seen = await seenOf(spec);
    expect(seen.filter((id) => id === "side")).toHaveLength(1);
    expect(seen.filter((id) => id === "done")).toHaveLength(1);
    expect(joinCount(seen)).toBe(1);
  });

  it("still joins on the success path of a node with an error-recovery route", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "barrier-recovery" },
      state: { channels: { seen: { type: "array", reducer: "append" } } },
      nodes: [
        { ...mark("a"), on: { error: "route:fallback" } },
        mark("x"),
        mark("z"),
        mark("join"),
        mark("fallback"),
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "START", to: "z" },
        { from: "a", to: "x" },
        { from: ["x", "z"], to: "join" },
        { from: "join", to: "END" },
        { from: "fallback", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;

    expect(validateSpec(spec).some((d) => d.code === "BARRIER_CONDITIONAL_SOURCE")).toBe(false);
    expect(validateSpec(spec).filter((d) => d.severity === "error")).toEqual([]);
    const seen = await seenOf(spec);
    expect(seen).toEqual(expect.arrayContaining(["a", "x", "z"]));
    expect(joinCount(seen)).toBe(1);
    expect(seen).not.toContain("fallback");
  });

  it("rejects the failing source in START to [e, z] then [e, z] to join", async () => {
    const spec = recoveryBarrier({
      id: "e",
      type: "function",
      with: { fn: "joinBarrierFail" },
      on: { error: "route:rec" },
    });
    await expectRecoverySource(spec, "e");
  });

  it("rejects a map whose item has an error recovery route", async () => {
    const spec = recoveryBarrier({
      id: "e",
      type: "map",
      with: {
        over: "{{ state.items }}",
        node: {
          id: "inner",
          type: "function",
          on: { error: "route:rec" },
          with: { fn: "joinBarrierFail" },
        },
      },
    });
    await expectRecoverySource(spec, "e");
  });

  it("rejects a barrier source selected by a route hook", async () => {
    const spec = recoveryBarrier({
      id: "e",
      type: "function",
      with: { fn: "joinBarrierFail" },
    });
    spec.runtime = {
      checkpoint: { enabled: false },
      hooks: [{ on: "node:error", where: { nodeId: "e" }, do: "route:rec" }],
    } as unknown as GraphSpec["runtime"];
    await expectRecoverySource(spec, "e");
  });

  it("reports a short list, END, and a self-target from compileGraph", async () => {
    const one = graph([
      { from: "START", to: "split" },
      { from: ["short"], to: "join" },
      { from: "join", to: "END" },
    ]);
    const endList = graph([
      { from: "START", to: "split" },
      { from: ["END"], to: "join" },
    ]);
    const endPair = graph([
      { from: "START", to: "split" },
      { from: ["END", "short"], to: "join" },
      { from: "join", to: "END" },
    ]);
    const selfList = graph([
      { from: "START", to: "split" },
      { from: ["join"], to: "join" },
    ]);

    expect(
      validateSpec(one).some(
        (d) => d.code === "BARRIER_SOURCE_INVALID" && d.message.includes("at least two"),
      ),
    ).toBe(true);
    await expect(compileGraph(one, {})).rejects.toMatchObject({
      code: "BARRIER_SOURCE_INVALID",
      message: expect.stringContaining("at least two"),
    });

    expect(
      validateSpec(endList).some(
        (d) => d.code === "BARRIER_SOURCE_INVALID" && d.message.includes("cannot be a barrier source"),
      ),
    ).toBe(true);
    await expect(compileGraph(endList, {})).rejects.toMatchObject({
      code: "BARRIER_SOURCE_INVALID",
      message: expect.stringContaining('"END"'),
    });
    await expect(compileGraph(endPair, {})).rejects.toMatchObject({
      code: "BARRIER_SOURCE_INVALID",
      message: expect.stringContaining("cannot be a barrier source"),
    });

    expect(validateSpec(selfList).some((d) => d.code === "BARRIER_SELF_SOURCE")).toBe(true);
    await expect(compileGraph(selfList, {})).rejects.toMatchObject({
      message: expect.stringContaining("wait for itself"),
    });
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
