import { describe, it, expect } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { registerFunction } from "../nodes/function.js";
import { withoutReservedKeys } from "../node-policy.js";
import type { FlowgraphEvent } from "../events.js";
import {
  createFakeTransport,
  createRemoteNodeExecutor,
  PlacementUnsatisfiedError,
  wrapperSpecForNode,
  type DispatchRequest,
  type FakeRun,
  type FakeTransportFixture,
  type Topology,
  type WorkerOutcome,
} from "./index.js";
import type { NodeRunContext } from "../context.js";

registerFunction("rxUpper", (input) => String((input as { text?: string }).text ?? "").toUpperCase());
registerFunction("rxDouble", (input) => ({ n: Number((input as { v?: unknown }).v) * 2 }));
registerFunction("rxTag", (input) => ({ tag: `${(input as { v?: string }).v}-tagged` }));

const WIN = { labels: ["os:windows"], flowgraphVersion: "0.42" };
const topo = (...names: string[]): Topology => ({ targets: Object.fromEntries(names.map((n) => [n, { url: `http://${n}.test` }])) });
const spec = (x: unknown) => ({ apiVersion: "flowgraph/v1", kind: "Graph", ...(x as object) }) as unknown as GraphSpec;
const LOCAL_MAC = ["os:macos"];

/** A worker simulator: runs the dispatched child graph in-process, as a real worker would. */
function localWorker(): (id: string, req: DispatchRequest | undefined) => Promise<FakeRun> {
  return async (id, req) => {
    const g = await compileGraph(req!.spec);
    const r = await g.run({ input: (req!.input ?? {}) as Record<string, unknown>, threadId: id });
    const outcome: WorkerOutcome =
      r.status === "completed"
        ? { status: "completed", state: withoutReservedKeys(r.state) }
        : { status: "error", error: { message: r.error?.message ?? r.status } };
    return { outcome };
  };
}

const child = spec({
  metadata: { name: "child" },
  state: { channels: { topic: { type: "string" }, shout: { type: "string" }, log: { type: "array", reducer: "append" } } },
  nodes: [
    { id: "up", type: "function", with: { fn: "rxUpper", input: { text: "{{ state.topic }}" }, output: { to: "shout" } } },
    { id: "lg", type: "function", with: { fn: "rxUpper", input: { text: "child-ran" }, output: { to: "log" } } },
  ],
  edges: [
    { from: "START", to: "up" },
    { from: "up", to: "lg" },
    { from: "lg", to: "END" },
  ],
});

function subgraphParent(runsOn: unknown) {
  return spec({
    metadata: { name: "parent-sg" },
    state: {
      channels: {
        topic: { type: "string", default: "hello" },
        loud: { type: "string" },
        log: { type: "array", reducer: "append", default: ["start"] },
      },
    },
    nodes: [
      {
        id: "place",
        type: "subgraph",
        spec: child,
        runsOn,
        with: { stateMap: { in: { topic: "topic", log: "log" }, out: { loud: "shout", log: "log" } } },
      },
    ],
    edges: [
      { from: "START", to: "place" },
      { from: "place", to: "END" },
    ],
  });
}

function fnParent(extra: Record<string, unknown> = {}, nodeExtra: Record<string, unknown> = {}, withOutput: unknown = { to: "doubled", map: { label: "{{ result.n }}x" } }) {
  return spec({
    metadata: { name: "parent-fn" },
    state: { channels: { seed: { type: "number", default: 21 }, doubled: { type: "object" }, label: { type: "string" } } },
    nodes: [
      {
        id: "dbl",
        type: "function",
        runsOn: ["os:windows"],
        input: { x: "{{ state.seed }}" },
        with: { fn: "rxDouble", input: { v: "{{ input.x }}" }, output: withOutput },
        ...nodeExtra,
      },
    ],
    edges: [
      { from: "START", to: "dbl" },
      { from: "dbl", to: "END" },
    ],
    ...extra,
  });
}

async function build(graph: GraphSpec, fixtures: Record<string, FakeTransportFixture>, localLabels: string[], names = Object.keys(fixtures)) {
  const transport = createFakeTransport(fixtures);
  const compiled = await compileGraph(graph, { placement: { localLabels, topology: topo(...names), transport } });
  return { transport, compiled };
}

describe("remote execution of placed nodes", () => {
  it("a local decision makes no transport calls", async () => {
    const { transport, compiled } = await build(fnParent(), { w1: { labels: WIN } }, ["os:windows"]);
    const r = await compiled.run({ threadId: "t-local" });
    expect(r.status).toBe("completed");
    expect(transport.dispatchCalls).toEqual([]);
    expect(transport.attachCalls).toEqual([]);
    expect(transport.preflightCalls).toEqual([]);
    expect((r.state.outputs as Record<string, unknown>).dbl).toEqual({ n: 42 });
  });

  it("graphs without runsOn are unaffected and never touch the transport", async () => {
    const g = spec({
      metadata: { name: "plain" },
      state: { channels: { out: { type: "string" } } },
      nodes: [{ id: "u", type: "function", with: { fn: "rxUpper", input: { text: "hi" }, output: { to: "out" } } }],
      edges: [{ from: "START", to: "u" }, { from: "u", to: "END" }],
    });
    const transport = createFakeTransport({ w1: { labels: WIN } });
    const compiled = await compileGraph(g, { placement: { localLabels: LOCAL_MAC, topology: topo("w1"), transport } });
    expect((await compiled.run({ threadId: "t" })).state.out).toBe("HI");
    expect(transport.preflightCalls.length + transport.dispatchCalls.length).toBe(0);
  });

  describe("parity with in-process", () => {
    it("remote subgraph seeds and merges like the local one", async () => {
      const local = await compileGraph(subgraphParent(["os:macos"]), { placement: { localLabels: LOCAL_MAC } });
      const localState = (await local.run({ threadId: "t-par" })).state;

      const { transport, compiled } = await build(subgraphParent(["os:windows"]), { w1: { labels: WIN, attach: localWorker() } }, LOCAL_MAC);
      const r = await compiled.run({ threadId: "t-par" });
      expect(r.status).toBe("completed");
      expect(transport.dispatchCalls).toHaveLength(1);
      const sent = transport.dispatchCalls[0]!.req;
      // seeded exactly as stateMap.in says
      expect(sent.input).toEqual({ topic: "hello", log: ["start"] });
      expect(sent.childThreadId).toBe("t-par/place/1");
      expect(r.state).toEqual(localState);
      expect(r.state.loud).toBe("HELLO");
      // append reducer sees only the child's new item (delta), not a duplicate of the seed
      expect(r.state.log).toEqual(["start", "CHILD-RAN"]);
    });

    it("remote non-subgraph node: outputs.<id>, output.to and output.map match", async () => {
      const local = await compileGraph(fnParent(), { placement: { localLabels: ["os:windows"] } });
      const localState = (await local.run({ threadId: "t-fn" })).state;

      const { transport, compiled } = await build(fnParent(), { w1: { labels: WIN, attach: localWorker() } }, LOCAL_MAC);
      const r = await compiled.run({ threadId: "t-fn" });
      expect(r.status).toBe("completed");
      // the wrapped node was handed the node's resolved input
      expect(transport.dispatchCalls[0]!.req.input).toEqual({ x: 21 });
      const wrapped = transport.dispatchCalls[0]!.req.spec.nodes[0] as { runsOn?: unknown; with: { output?: unknown } };
      expect(wrapped.runsOn).toBeUndefined();
      expect(wrapped.with.output).toBeUndefined();
      expect(r.state.doubled).toEqual({ n: 42 });
      expect(r.state.label).toBe("42x");
      expect(r.state).toEqual(localState);
    });

    it("output: none keeps the parent state untouched, as in-process", async () => {
      const { compiled } = await build(fnParent({}, {}, "none"), { w1: { labels: WIN, attach: localWorker() } }, LOCAL_MAC);
      const r = await compiled.run({ threadId: "t-none" });
      expect(r.status).toBe("completed");
      expect(r.state.outputs ?? {}).toEqual({});
    });
  });

  it("wrapperSpecForNode carries the resolved input through child channels", () => {
    const node = fnParent().nodes[0]!;
    const w = wrapperSpecForNode(node, { x: 1, "a-b": 2 });
    const n = w.nodes[0] as { input: Record<string, string>; retry?: unknown; when?: unknown };
    expect(n.input).toEqual({ x: "{{ state.x }}", "a-b": '{{ state["a-b"] }}' });
    expect(Object.keys(w.state!.channels!)).toEqual(["x", "a-b"]);
    expect(n.retry).toBeUndefined();
  });

  it("dispatch returning `exists` attaches without dispatching again", async () => {
    const { transport, compiled } = await build(
      fnParent(),
      { w1: { labels: WIN, dispatch: { status: "exists", runStatus: "running", active: true }, attach: { outcome: { status: "completed", state: { outputs: { dbl: { n: 7 } } } } } } },
      LOCAL_MAC,
    );
    const r = await compiled.run({ threadId: "t-exists" });
    expect(r.status).toBe("completed");
    expect(transport.dispatchCalls).toHaveLength(1);
    expect(transport.attachCalls).toHaveLength(1);
    expect(r.state.doubled).toEqual({ n: 7 });
  });

  it("re-entry after a recorded dispatch attaches and never dispatches", async () => {
    const transport = createFakeTransport({ w1: { labels: WIN, attach: { outcome: { status: "completed", state: { ok: 1 } } } } });
    const exec = createRemoteNodeExecutor({
      node: fnParent().nodes[0]!,
      decision: { nodeId: "dbl", kind: "remote", target: "w1", required: [], candidates: [] },
      topology: topo("w1"),
      transport,
      localLabels: LOCAL_MAC,
    });
    const recorded = { target: "w1", childThreadId: "t-re/dbl/1" };
    const keys: string[] = [];
    const ctx = {
      nodeId: "dbl",
      attempt: 1,
      meta: { threadId: "t-re", graph: "g", runId: "r", startedAt: "" },
      events: { emit() {} },
      once: async (k: string) => {
        keys.push(k);
        return recorded;
      },
    } as unknown as NodeRunContext;
    const state = await exec.execute({ ctx, spec: fnParent(), input: {} });
    expect(state).toEqual({ ok: 1 });
    expect(transport.dispatchCalls).toEqual([]);
    expect(transport.attachCalls.map((c) => c.childThreadId)).toEqual(["t-re/dbl/1"]);
    expect(keys).toEqual(["placement:dbl:1"]);
  });

  describe("outcomes", () => {
    it("error -> REMOTE_NODE_FAILED naming the target and the child's message", async () => {
      const { compiled } = await build(
        fnParent(),
        { w1: { labels: WIN, attach: { outcome: { status: "error", error: { message: "cc5 crashed" } } } } },
        LOCAL_MAC,
      );
      const r = await compiled.run({ threadId: "t-err" });
      expect(r.status).toBe("error");
      expect(r.error?.message).toMatch(/REMOTE_NODE_FAILED/);
      expect(r.error?.message).toContain('"w1"');
      expect(r.error?.message).toContain("cc5 crashed");
      expect((r.error as { code?: string }).code).toBe("REMOTE_NODE_FAILED");
    });

    it("retry runs a new attempt with a new child id", async () => {
      const { transport, compiled } = await build(
        fnParent({}, { retry: { maxAttempts: 2, baseMs: 1, jitter: false } }),
        {
          w1: {
            labels: WIN,
            attach: [{ outcome: { status: "error", error: { message: "flaky" } } }, { outcome: { status: "completed", state: { outputs: { dbl: { n: 2 } } } } }],
          },
        },
        LOCAL_MAC,
      );
      const r = await compiled.run({ threadId: "t-retry" });
      expect(r.status).toBe("completed");
      expect(transport.dispatchCalls.map((c) => c.req.childThreadId)).toEqual(["t-retry/dbl/1", "t-retry/dbl/2"]);
      expect(r.state.doubled).toEqual({ n: 2 });
    });

    it("a transport failure re-resolves the node's placement on retry", async () => {
      let reads = 0;
      const w1: FakeTransportFixture = {
        // reachable at compile time, unreachable when matching runs again
        get labels() {
          return ++reads === 1 ? WIN : new Error("connect ECONNREFUSED");
        },
        attach: { outcome: new Error("lost event stream") },
      } as FakeTransportFixture;
      const { transport, compiled } = await build(
        fnParent({}, { retry: { maxAttempts: 2, baseMs: 1, jitter: false } }),
        { w1, w2: { labels: WIN, attach: { outcome: { status: "completed", state: { outputs: { dbl: { n: 9 } } } } } } },
        LOCAL_MAC,
      );
      const r = await compiled.run({ threadId: "t-tf" });
      expect(r.status).toBe("completed");
      expect(transport.dispatchCalls.map((c) => [c.target, c.req.childThreadId])).toEqual([
        ["w1", "t-tf/dbl/1"],
        ["w2", "t-tf/dbl/2"],
      ]);
    });

    it("a transport failure with no replacement fails REMOTE_NODE_FAILED", async () => {
      const { compiled } = await build(
        fnParent(),
        { w1: { labels: WIN, attach: { outcome: new Error("lost event stream") } } },
        LOCAL_MAC,
      );
      const r = await compiled.run({ threadId: "t-tf2" });
      expect(r.status).toBe("error");
      expect(r.error?.message).toMatch(/REMOTE_NODE_FAILED.*lost contact with target "w1".*lost event stream/s);
    });

    it("an unreachable worker at dispatch is REMOTE_NODE_FAILED", async () => {
      const { compiled } = await build(fnParent(), { w1: { labels: WIN, dispatch: new Error("ECONNREFUSED") } }, LOCAL_MAC);
      const r = await compiled.run({ threadId: "t-dis" });
      expect(r.error?.message).toMatch(/REMOTE_NODE_FAILED.*could not be dispatched.*ECONNREFUSED/s);
    });

    it("a child cancelled by someone else -> REMOTE_NODE_CANCELLED", async () => {
      const { compiled } = await build(fnParent(), { w1: { labels: WIN, attach: { outcome: { status: "cancelled" } } } }, LOCAL_MAC);
      const r = await compiled.run({ threadId: "t-can" });
      expect(r.status).toBe("error");
      expect((r.error as { code?: string }).code).toBe("REMOTE_NODE_CANCELLED");
    });

    it("interrupted -> child cancelled and PLACEMENT_GATE_UNSUPPORTED, not retried", async () => {
      const { transport, compiled } = await build(
        fnParent({}, { retry: { maxAttempts: 3, baseMs: 1, jitter: false } }),
        { w1: { labels: WIN, attach: { outcome: { status: "interrupted", interrupts: [{}] } } } },
        LOCAL_MAC,
      );
      const r = await compiled.run({ threadId: "t-gate" });
      expect(r.status).toBe("error");
      expect((r.error as { code?: string }).code).toBe("PLACEMENT_GATE_UNSUPPORTED");
      expect(r.error?.message).toContain("phase 2");
      expect(transport.cancelCalls).toEqual([{ target: "w1", childThreadId: "t-gate/dbl/1" }]);
      expect(transport.dispatchCalls).toHaveLength(1);
    });
  });

  it("a node:error hook retry gets a new child id, deterministically", async () => {
    let hooked = 0;
    const hook = { phase: "node:error" as const, handler: () => (hooked++ === 0 ? { kind: "retry" as const } : undefined) };
    const transport = createFakeTransport({
      w1: { labels: WIN, attach: [{ outcome: { status: "error", error: { message: "once" } } }, { outcome: { status: "completed", state: { outputs: { dbl: { n: 3 } } } } }] },
    });
    const compiled = await compileGraph(fnParent(), { hooks: [hook as never], placement: { localLabels: LOCAL_MAC, topology: topo("w1"), transport } });
    const r = await compiled.run({ threadId: "t-hook" });
    expect(r.status).toBe("completed");
    expect(transport.dispatchCalls.map((c) => c.req.childThreadId)).toEqual(["t-hook/dbl/1", "t-hook/dbl/2"]);
  });

  it("aborting the parent run cancels the running child once and stops attaching", async () => {
    const { transport, compiled } = await build(fnParent(), { w1: { labels: WIN, attach: { hang: true } } }, LOCAL_MAC);
    const ac = new AbortController();
    const running = compiled.run({ threadId: "t-abort", signal: ac.signal });
    for (let i = 0; i < 200 && transport.attachCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(transport.attachCalls).toHaveLength(1);
    ac.abort();
    const r = await running;
    expect(r.status).toBe("aborted");
    expect(transport.cancelCalls).toEqual([{ target: "w1", childThreadId: "t-abort/dbl/1" }]);
    expect(transport.attachCalls[0]!.opts?.signal?.aborted).toBe(true);
  });

  it("a thread id that makes the child id too long fails before dispatch", async () => {
    const { transport, compiled } = await build(fnParent(), { w1: { labels: WIN } }, LOCAL_MAC);
    const r = await compiled.run({ threadId: "x".repeat(240) });
    expect(r.status).toBe("error");
    expect((r.error as { code?: string }).code).toBe("PLACEMENT_THREAD_ID_TOO_LONG");
    expect(transport.dispatchCalls).toEqual([]);
  });

  it("child events are forwarded under the node and every placed event carries placement", async () => {
    const events: FlowgraphEvent[] = [];
    const wev = (type: string, seq: number, scope: object = {}) => ({ type, seq, data: { v: seq }, scope });
    const { compiled } = await build(
      fnParent(),
      {
        w1: {
          labels: WIN,
          attach: {
            events: [wev("run.start", 0), wev("node.start", 1, { nodeId: "dbl" }), wev("agent.step", 2, { nodeId: "inner" }), wev("node.end", 3, { nodeId: "dbl" }), wev("run.end", 4)],
            outcome: { status: "completed", state: { outputs: { dbl: { n: 1 } } } },
          },
        },
      },
      LOCAL_MAC,
    );
    const r = await compiled.run({ threadId: "t-ev", sinks: [(e) => void events.push(e)] });
    expect(r.status).toBe("completed");
    const placement = { target: "w1", childThreadId: "t-ev/dbl/1" };
    const mine = events.filter((e) => e.scope.nodeId === "dbl" && (e.type === "node.start" || e.type === "node.end") && !e.scope.parentSpanId);
    expect(mine.map((e) => e.type)).toEqual(["node.start", "node.end"]);
    for (const e of mine) expect(e.scope.placement).toEqual(placement);
    const fwd = events.filter((e) => e.scope.parentSpanId === "dbl");
    expect(fwd.map((e) => e.type)).toEqual(["agent.step"]); // run.* and the wrapper's own node events are not repeated
    expect(fwd[0]!.scope).toMatchObject({ nodeId: "inner", parentSpanId: "dbl", placement });
    expect(events.some((e) => e.type === "run.end" && e.scope.parentSpanId)).toBe(false);
  });

  describe("compile-time failures", () => {
    it("queued (runsOn.wait) throws and says wait arrives in phase 2", async () => {
      const g = fnParent();
      (g.nodes[0] as { runsOn: unknown }).runsOn = { labels: ["os:windows"], wait: "30m" };
      const transport = createFakeTransport({ w1: { labels: { labels: ["os:linux"], flowgraphVersion: "0.42" } } });
      const err = await compileGraph(g, { placement: { localLabels: LOCAL_MAC, topology: topo("w1"), transport } }).catch((e) => e);
      expect(err).toBeInstanceOf(PlacementUnsatisfiedError);
      expect(err.message).toMatch(/wait.*phase 2/);
      expect(err.decisions[0].kind).toBe("queued");
    });

    it("unsatisfied throws with each candidate's reason", async () => {
      const transport = createFakeTransport({ w1: { labels: { labels: ["os:linux"], flowgraphVersion: "0.42" } } });
      const err = await compileGraph(fnParent(), { placement: { localLabels: LOCAL_MAC, topology: topo("w1"), transport } }).catch((e) => e);
      expect(err).toBeInstanceOf(PlacementUnsatisfiedError);
      expect(err.message).toContain("PLACEMENT_UNSATISFIED");
      expect(err.message).toContain("w1");
      expect(transport.dispatchCalls).toEqual([]);
    });

    it("standalone (no topology or transport): non-local throws, fallback: local runs here", async () => {
      await expect(compileGraph(fnParent(), { placement: { localLabels: LOCAL_MAC } })).rejects.toBeInstanceOf(PlacementUnsatisfiedError);
      const g = fnParent();
      (g.nodes[0] as { runsOn: unknown }).runsOn = { labels: ["os:windows"], fallback: "local" };
      const r = await (await compileGraph(g, { placement: { localLabels: LOCAL_MAC } })).run({ threadId: "t-fb" });
      expect(r.state.doubled).toEqual({ n: 42 });
    });

    it("map and router with runsOn are refused even when they would resolve local", async () => {
      const g = spec({
        metadata: { name: "m" },
        state: { channels: { items: { type: "array", default: [1] } } },
        nodes: [{ id: "m", type: "map", runsOn: ["os:macos"], with: { items: "{{ state.items }}", node: { id: "i", type: "function", with: { fn: "rxUpper" } } } }],
        edges: [{ from: "START", to: "m" }, { from: "m", to: "END" }],
      });
      await expect(compileGraph(g, { placement: { localLabels: LOCAL_MAC } })).rejects.toThrow(/map nodes cannot run remotely/);
    });

    it("remote map and router nodes are refused with a pointer to subgraphs", async () => {
      const g = spec({
        metadata: { name: "m" },
        state: { channels: { items: { type: "array", default: [1] } } },
        nodes: [{ id: "m", type: "map", runsOn: ["os:windows"], with: { items: "{{ state.items }}", node: { id: "i", type: "function", with: { fn: "rxUpper" } } } }],
        edges: [{ from: "START", to: "m" }, { from: "m", to: "END" }],
      });
      const transport = createFakeTransport({ w1: { labels: WIN } });
      await expect(compileGraph(g, { placement: { localLabels: LOCAL_MAC, topology: topo("w1"), transport } })).rejects.toThrow(/map nodes cannot run remotely/);
    });

    it("runsOn below the top level is refused at compile instead of being ignored", async () => {
      const g = spec({
        metadata: { name: "nested" },
        nodes: [
          {
            id: "sg",
            type: "subgraph",
            spec: {
              apiVersion: "flowgraph/v1",
              kind: "Graph",
              metadata: { name: "child" },
              nodes: [{ id: "leaf", type: "function", runsOn: ["os:macos"], with: { fn: "rxUpper" } }],
              edges: [{ from: "START", to: "leaf" }, { from: "leaf", to: "END" }],
            },
          },
        ],
        edges: [{ from: "START", to: "sg" }, { from: "sg", to: "END" }],
      });
      const err = await compileGraph(g, { placement: { localLabels: LOCAL_MAC } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { diagnostics?: Array<{ code: string }> }).diagnostics?.map((d) => d.code)).toEqual(["PLACEMENT_NOT_TOP_LEVEL"]);
    });
  });
});
