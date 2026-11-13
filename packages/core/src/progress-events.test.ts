import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { EdgeTakenData, FlowgraphEvent, StateUpdateData } from "./events.js";
import type { Hook } from "./hooks/types.js";

function spec(
  nodes: unknown[],
  edges: unknown[],
  channels: Record<string, unknown> = {},
): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "progress" },
    nodes,
    edges,
    state: { channels },
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}
const fn = (id: string, name: string, output: unknown = "none") => ({
  id,
  type: "function",
  with: { fn: name, output },
});
const edge = (from: string, to: string | string[]) => ({ from, to });
const changes = (events: FlowgraphEvent[]) =>
  events.filter((e) => e.type === "state.update") as FlowgraphEvent<StateUpdateData>[];
const transitions = (events: FlowgraphEvent[]) =>
  events.filter((e) => e.type === "edge.taken").map((e) => e.data as EdgeTakenData);

async function record(graph: GraphSpec, hooks: Hook[] = []) {
  const events: FlowgraphEvent[] = [];
  const compiled = await compileGraph(graph, {
    sinks: [
      (e) => {
        events.push(e);
      },
    ],
    hooks,
  });
  return { compiled, events };
}

describe("committed state progress", () => {
  it("emits reduced replacement values for one parallel superstep, before run.end", async () => {
    registerFunction("progress-a", () => ["a"]);
    registerFunction("progress-b", () => ["b"]);
    const { compiled, events } = await record(
      spec(
        [fn("a", "progress-a", { to: "items" }), fn("b", "progress-b", { to: "items" })],
        [edge("START", ["a", "b"]), edge("a", "END"), edge("b", "END")],
        { items: { type: "array", reducer: "append", default: ["seed"] } },
      ),
    );
    const result = await compiled.run({ threadId: "parallel-progress" });
    expect(result.status).toBe("completed");
    expect(changes(events)).toHaveLength(1);
    expect(changes(events)[0]!.data.update.items).toEqual(["seed", "a", "b"]);
    expect(changes(events)[0]!.data.channels).toContain("items");
    expect(changes(events)[0]!.data.channels.every((key) => !key.startsWith("__"))).toBe(true);
    expect(events.findIndex((e) => e.type === "state.update")).toBeLessThan(
      events.findIndex((e) => e.type === "run.end"),
    );
    expect(events.every((e) => e.threadId === "parallel-progress")).toBe(true);
  });

  it("does not emit initial input, equal object writes, output:none, or bookkeeping writes", async () => {
    registerFunction("progress-equal", () => ({ value: 1 }));
    registerFunction("progress-once", async (_, ctx) => ctx.once("progress-once", async () => 3));
    const { compiled, events } = await record(
      spec(
        [fn("same", "progress-equal", { to: "result" }), fn("empty", "progress-once")],
        [edge("START", "same"), edge("same", "empty"), edge("empty", "END")],
        { result: { type: "object" } },
      ),
    );
    await compiled.run({ threadId: "noop-progress", input: { result: { value: 1 } } });
    // The public outputs slug is itself a state channel. The equal result is
    // omitted, while recording that slug for the first time is a real change.
    expect(changes(events).flatMap((e) => e.data.channels)).toEqual(["outputs"]);
    expect(changes(events).some((e) => "result" in e.data.update)).toBe(false);
  });

  it("observes hook-transformed committed values and no failed retry proposals", async () => {
    let attempts = 0;
    registerFunction("progress-retry", () => {
      if (++attempts === 1) throw new Error("try again");
      return "raw";
    });
    const graph = spec(
      [
        {
          ...fn("work", "progress-retry", { to: "value" }),
          retry: { maxAttempts: 2, backoff: "1ms" },
        },
      ],
      [edge("START", "work"), edge("work", "END")],
      { value: { type: "string" } },
    );
    const hook: Hook = {
      phase: "state:beforeUpdate",
      handler: () => ({ kind: "mutate", payload: { update: { value: "safe" } } }),
    };
    const { compiled, events } = await record(graph, [hook]);
    const result = await compiled.run({ threadId: "retry-progress" });
    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(changes(events).map((e) => e.data.update)).toEqual([{ value: "safe" }]);
    expect(transitions(events)).toEqual([
      { from: "START", to: "work", kind: "static" },
      { from: "work", to: "END", kind: "static" },
    ]);
  });

  it("keeps an interrupted node silent until resume and does not repeat START", async () => {
    const { compiled, events } = await record(
      spec(
        [{ id: "gate", type: "wait", with: { signal: "ready", output: { to: "answer" } } }],
        [edge("START", "gate"), edge("gate", "END")],
        { answer: { type: "object" } },
      ),
    );
    expect((await compiled.run({ threadId: "gate-progress", onInterrupt: "fail" })).status).toBe(
      "interrupted",
    );
    expect(changes(events)).toHaveLength(0);
    expect(transitions(events)).toEqual([{ from: "START", to: "gate", kind: "static" }]);
    expect(
      (
        await compiled.resume({
          threadId: "gate-progress",
          resume: { ok: true },
          onInterrupt: "fail",
        })
      ).status,
    ).toBe("completed");
    expect(changes(events)).toHaveLength(1);
    expect(changes(events)[0]!.data.update.answer).toEqual({ ok: true });
    expect(transitions(events)).toHaveLength(2);
  });

  it("does not replay state deltas when continuing past a static breakpoint", async () => {
    registerFunction("progress-step", () => "next");
    const graph = spec(
      [
        fn("first", "progress-step", { to: "value" }),
        fn("second", "progress-step", { to: "value" }),
      ],
      [edge("START", "first"), edge("first", "second"), edge("second", "END")],
      { value: { type: "string" } },
    );
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(graph, {
      interruptAfter: ["first"],
      sinks: [
        (e) => {
          events.push(e);
        },
      ],
    });
    expect((await compiled.run({ threadId: "breakpoint-progress" })).status).toBe("interrupted");
    expect(changes(events)).toHaveLength(1);
    expect((await compiled.continueRun({ threadId: "breakpoint-progress" })).status).toBe(
      "completed",
    );
    // Only outputs.second changes on continuation, never value again.
    expect(changes(events)).toHaveLength(2);
    expect(changes(events)[1]!.data.channels).toEqual(["outputs"]);
    expect(transitions(events).filter((e) => e.from === "first")).toHaveLength(1);
  });

  it("preserves event thread attribution when a compiled graph runs concurrent threads", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerFunction("progress-concurrent", async (_, ctx) => {
      if (ctx.meta.threadId === "slow") {
        entered();
        await waiting;
      }
      return ctx.meta.threadId;
    });
    const { compiled, events } = await record(
      spec(
        [fn("work", "progress-concurrent", { to: "value" })],
        [edge("START", "work"), edge("work", "END")],
        { value: { type: "string" } },
      ),
    );
    const slow = compiled.run({ threadId: "slow" });
    await started;
    expect((await compiled.run({ threadId: "fast" })).status).toBe("completed");
    release();
    expect((await slow).status).toBe("completed");
    expect(changes(events).map((e) => [e.threadId, e.data.update.value])).toEqual([
      ["fast", "fast"],
      ["slow", "slow"],
    ]);
    for (const threadId of ["fast", "slow"])
      expect(transitions(events.filter((e) => e.threadId === threadId))).toHaveLength(2);
  });
});

describe("partial superstep progress", () => {
  it("reports completed siblings at an interrupt and does not repeat their changes on resume", async () => {
    let calls = 0;
    registerFunction("progress-partial", () => {
      calls++;
      return "done";
    });
    const { compiled, events } = await record(
      spec(
        [
          fn("work", "progress-partial", { to: "value" }),
          { id: "gate", type: "wait", with: { signal: "ready", output: { to: "answer" } } },
        ],
        [edge("START", ["work", "gate"]), edge("work", "END"), edge("gate", "END")],
        { value: { type: "string" }, answer: { type: "object" } },
      ),
    );
    expect((await compiled.run({ threadId: "partial-progress" })).status).toBe("interrupted");
    expect(changes(events)).toHaveLength(1);
    expect(changes(events)[0]!.data.update.value).toBe("done");
    expect(
      (
        await compiled.resume({
          threadId: "partial-progress",
          resume: { ready: true },
          onInterrupt: "fail",
        })
      ).status,
    ).toBe("completed");
    expect(calls).toBe(1);
    expect(changes(events)).toHaveLength(2);
    expect(changes(events)[1]!.data.update.answer).toEqual({ ready: true });
    expect(changes(events)[1]!.data.channels).not.toContain("value");
    expect(transitions(events).filter((event) => event.from === "work")).toHaveLength(1);
  });
});

describe("nested partial progress", () => {
  it("reports child writes only once its interrupted superstep finishes", async () => {
    registerFunction("progress-nested-partial", () => "child-done");
    const child = spec(
      [
        fn("work", "progress-nested-partial", { to: "value" }),
        { id: "gate", type: "wait", with: { signal: "ready", output: { to: "answer" } } },
      ],
      [edge("START", ["work", "gate"]), edge("work", "END"), edge("gate", "END")],
      { value: { type: "string" }, answer: { type: "object" } },
    );
    const { compiled, events } = await record(
      spec(
        [{ id: "embed", type: "subgraph", spec: child, with: { output: "none" } }],
        [edge("START", "embed"), edge("embed", "END")],
      ),
    );
    expect((await compiled.run({ threadId: "nested-partial-progress" })).status).toBe(
      "interrupted",
    );
    const before = changes(events).filter((event) => event.scope.parentSpanId === "embed");
    // Nested LangGraph interrupts propagate before the child applies its
    // pending sibling writes. Only the outer graph applies partial steps.
    expect(before).toHaveLength(0);
    expect(
      (
        await compiled.resume({
          threadId: "nested-partial-progress",
          resume: { ready: true },
          onInterrupt: "fail",
        })
      ).status,
    ).toBe("completed");
    const after = changes(events).filter((event) => event.scope.parentSpanId === "embed");
    expect(after).toHaveLength(1);
    expect(after[0]!.data.update.value).toBe("child-done");
    expect(after[0]!.data.update.answer).toEqual({ ready: true });
  });
});

describe("canonical progress values", () => {
  it("preserves the state API's JSON representation for messages and buffers", async () => {
    registerFunction("progress-message", () => [
      new AIMessage({ content: "done", id: "progress-answer" }),
    ]);
    registerFunction("progress-buffer", () => Buffer.from([1, 2, 3]));
    const { compiled, events } = await record(
      spec(
        [
          fn("message", "progress-message", { to: "messages" }),
          fn("bytes", "progress-buffer", { to: "bytesValue" }),
        ],
        [edge("START", ["message", "bytes"]), edge("message", "END"), edge("bytes", "END")],
        { messages: { type: "messages" }, bytesValue: { type: "object" } },
      ),
    );
    const result = await compiled.run({ threadId: "wire-progress" });
    expect(result.status).toBe("completed");
    const update = changes(events)[0]!.data.update;
    expect(JSON.stringify(update.messages)).toBe(JSON.stringify(result.state.messages));
    expect(JSON.stringify(update.bytesValue)).toBe(JSON.stringify(result.state.bytesValue));
    expect(update.messages).toEqual(JSON.parse(JSON.stringify(result.state.messages)));
  });
});

describe("progress event delivery", () => {
  it("delivers progress and terminal events through CompiledGraph.stream without hanging", async () => {
    registerFunction("progress-stream", () => "streamed");
    const compiled = await compileGraph(
      spec(
        [fn("work", "progress-stream", { to: "value" })],
        [edge("START", "work"), edge("work", "END")],
        { value: { type: "string" } },
      ),
    );
    const events: FlowgraphEvent[] = [];
    for await (const event of compiled.stream({ threadId: "stream-progress" })) events.push(event);
    expect(changes(events)[0]!.data.update.value).toBe("streamed");
    expect(events.at(-1)!.type).toBe("run.end");
    expect(events.every((event) => event.threadId === "stream-progress")).toBe(true);
  });

  it("does not let a sink change the graph state or later comparison baseline", async () => {
    registerFunction("progress-isolated", () => ({ nested: [1] }));
    const { compiled, events } = await record(
      spec(
        [
          fn("first", "progress-isolated", { to: "value" }),
          fn("second", "progress-isolated", { to: "value" }),
        ],
        [edge("START", "first"), edge("first", "second"), edge("second", "END")],
        { value: { type: "object" } },
      ),
    );
    compiled.events.subscribe((event) => {
      if (event.type === "state.update") {
        const value = (event.data as StateUpdateData).update.value as
          { nested?: number[] } | undefined;
        value?.nested?.push(99);
      }
    });
    const result = await compiled.run({ threadId: "isolated-progress" });
    expect(result.state.value).toEqual({ nested: [1] });
    expect(changes(events).filter((event) => "value" in event.data.update)).toHaveLength(1);
  });
});

describe("selected edge progress", () => {
  it("reports only selected conditional and router destinations, including END", async () => {
    registerFunction("progress-nop", () => null);
    const { compiled, events } = await record(
      spec(
        [
          fn("choose", "progress-nop"),
          {
            id: "route",
            type: "router",
            with: {
              routes: {
                yes: { when: "{{ state.ok }}", to: "finish" },
                no: { default: true, to: "END" },
              },
            },
          },
          fn("finish", "progress-nop"),
          fn("other", "progress-nop"),
        ],
        [
          edge("START", "choose"),
          {
            from: "choose",
            branch: [
              { when: "{{ state.ok }}", to: "route" },
              { default: true, to: "other" },
            ],
          },
          edge("route", ["finish", "other"]),
          edge("finish", "END"),
          edge("other", "END"),
        ],
        { ok: { type: "boolean", default: true } },
      ),
    );
    expect((await compiled.run({ threadId: "route-progress" })).status).toBe("completed");
    expect(transitions(events)).toEqual([
      { from: "START", to: "choose", kind: "static" },
      { from: "choose", to: "route", kind: "branch" },
      { from: "route", to: "finish", kind: "command" },
      { from: "finish", to: "END", kind: "static" },
    ]);
  });

  it("reports fan-in edges once each and runs the joined destination once", async () => {
    registerFunction("progress-join", () => null);
    const { compiled, events } = await record(
      spec(
        [fn("left", "progress-join"), fn("right", "progress-join"), fn("join", "progress-join")],
        [
          edge("START", ["left", "right"]),
          edge("left", "join"),
          edge("right", "join"),
          edge("join", "END"),
        ],
      ),
    );
    expect((await compiled.run({ threadId: "join-progress" })).status).toBe("completed");
    expect(transitions(events).filter((event) => event.to === "join")).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "node.start" && event.scope.nodeId === "join"),
    ).toHaveLength(1);
  });

  it("observes hook redirects and leaves both command and declared static dispatch intact", async () => {
    registerFunction("progress-hook", () => null);
    const { compiled, events } = await record(
      spec(
        [fn("work", "progress-hook"), fn("recovery", "progress-hook")],
        [edge("START", "work"), edge("work", ["recovery", "END"]), edge("recovery", "END")],
      ),
      [
        {
          phase: "node:before",
          where: { nodeId: "work" },
          handler: () => ({ kind: "route", to: "recovery" }),
        },
      ],
    );
    expect((await compiled.run({ threadId: "hook-progress" })).status).toBe("completed");
    expect(transitions(events)).toContainEqual({ from: "work", to: "recovery", kind: "command" });
    expect(transitions(events)).toContainEqual({ from: "work", to: "END", kind: "static" });
    expect(
      events.some((event) => event.type === "node.start" && event.scope.nodeId === "work"),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "node.start" && event.scope.nodeId === "recovery"),
    ).toBe(true);
  });

  it("reports default-to-END and every loop iteration", async () => {
    let count = 0;
    registerFunction("progress-counter", () => ++count);
    const { compiled, events } = await record(
      spec(
        [fn("tick", "progress-counter", { to: "count" })],
        [
          edge("START", "tick"),
          { from: "tick", branch: [{ when: "{{ state.count < 3 }}", to: "tick" }] },
        ],
        { count: { type: "number", default: 0 } },
      ),
    );
    expect((await compiled.run({ threadId: "loop-progress" })).status).toBe("completed");
    expect(changes(events).map((e) => e.data.update.count)).toEqual([1, 2, 3]);
    expect(transitions(events).map((e) => e.to)).toEqual(["tick", "tick", "tick", "END"]);
  });

  it("dispatches skipped nodes' outgoing edges without inventing state writes", async () => {
    registerFunction("progress-never", () => {
      throw new Error("must not run");
    });
    const { compiled, events } = await record(
      spec(
        [{ ...fn("skip", "progress-never"), when: "{{ false }}" }],
        [edge("START", "skip"), edge("skip", "END")],
      ),
    );
    expect((await compiled.run({ threadId: "skip-progress" })).status).toBe("completed");
    expect(changes(events)).toHaveLength(0);
    expect(transitions(events).map((e) => e.to)).toEqual(["skip", "END"]);
  });

  it("does not emit a failed node's outgoing edges or state update", async () => {
    registerFunction("progress-fail", () => {
      throw new Error("failed");
    });
    const { compiled, events } = await record(
      spec(
        [fn("fail", "progress-fail", { to: "value" })],
        [edge("START", "fail"), edge("fail", "END")],
        { value: { type: "string" } },
      ),
    );
    expect((await compiled.run({ threadId: "error-progress" })).status).toBe("error");
    expect(changes(events)).toHaveLength(0);
    expect(transitions(events)).toEqual([{ from: "START", to: "fail", kind: "static" }]);
  });

  it("forwards child progress with parentSpanId while keeping map internals out of graph edges", async () => {
    registerFunction("progress-item", () => ["item"]);
    const child = spec(
      [fn("child-step", "progress-item", { to: "items" })],
      [edge("START", "child-step"), edge("child-step", "END")],
      { items: { type: "array", reducer: "append" } },
    );
    const { compiled, events } = await record(
      spec(
        [
          { id: "embedded", type: "subgraph", spec: child, with: { output: "none" } },
          {
            id: "batch",
            type: "map",
            with: {
              over: "{{ [1, 2] }}",
              as: "item",
              node: { type: "function", with: { fn: "progress-item" } },
              collect: { to: "items" },
            },
          },
        ],
        [edge("START", "embedded"), edge("embedded", "batch"), edge("batch", "END")],
        { items: { type: "array" } },
      ),
    );
    expect((await compiled.run({ threadId: "nested-progress" })).status).toBe("completed");
    expect(
      changes(events).some((e) => e.scope.parentSpanId === "embedded" && "items" in e.data.update),
    ).toBe(true);
    expect(transitions(events.filter((e) => e.scope.parentSpanId === "embedded"))).toEqual([
      { from: "START", to: "child-step", kind: "static" },
      { from: "child-step", to: "END", kind: "static" },
    ]);
    expect(transitions(events.filter((e) => !e.scope.parentSpanId))).toEqual([
      { from: "START", to: "embedded", kind: "static" },
      { from: "embedded", to: "batch", kind: "static" },
      { from: "batch", to: "END", kind: "static" },
    ]);
    expect(
      events.filter((e) => e.type === "edge.taken").every((e) => e.threadId === "nested-progress"),
    ).toBe(true);
  });
});
