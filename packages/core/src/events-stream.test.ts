import { describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { createEventBus, withEventThread, type FlowgraphEvent } from "./events.js";
import { registerFunction } from "./nodes/function.js";

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("event stream did not terminate")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function collect(stream: AsyncIterable<FlowgraphEvent>) {
  const events: FlowgraphEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function graph(): GraphSpec {
  return {
    metadata: { name: "stream-invocations" },
    state: { channels: { value: { type: "number" } } },
    nodes: [
      {
        id: "work",
        type: "function",
        with: { fn: "stream-invocation-counter", output: { to: "value" } },
      },
    ],
    edges: [
      { from: "START", to: "work" },
      { from: "work", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("event stream lifecycle", () => {
  it("finishes after replaying an already-terminal buffer with trailing diagnostics", async () => {
    const bus = createEventBus({ runId: "late", graph: "late" });
    bus.emit("run.start", {});
    bus.emit("state.update", { channels: ["value"], update: { value: 1 } });
    bus.emit("run.end", {});
    bus.emit("log", { level: "info", msg: "cleanup complete" });
    const collected = collect(bus.stream());
    try {
      expect((await within(collected)).map((event) => event.type)).toEqual([
        "run.start",
        "state.update",
        "run.end",
        "log",
      ]);
    } finally {
      bus.emit("run.end", {});
      await collected;
    }
  });

  it("captures terminal and progress events emitted while a slow consumer yields buffered events", async () => {
    const bus = createEventBus({ runId: "slow", graph: "slow" });
    bus.emit("run.start", {});
    const iterator = bus.stream()[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("run.start");
    // The consumer is now suspended at its first yield, while execution finishes.
    bus.emit("state.update", { channels: ["value"], update: { value: 2 } });
    bus.emit("edge.taken", { from: "work", to: "END", kind: "static" });
    bus.emit("run.end", {});
    const rest = collect({ [Symbol.asyncIterator]: () => iterator });
    try {
      expect((await within(rest)).map((event) => event.type)).toEqual([
        "state.update",
        "edge.taken",
        "run.end",
      ]);
    } finally {
      bus.emit("run.end", {});
      await rest;
    }
  });

  it("a terminal event on another thread cannot close a live filtered stream", async () => {
    const bus = createEventBus({ runId: "threads", graph: "threads" });
    const iterator = bus.stream({ replay: false, threadId: "wanted" })[Symbol.asyncIterator]();
    const first = iterator.next();
    withEventThread("other", () => bus.emit("run.end", {}));
    withEventThread("wanted", () =>
      bus.emit("state.update", { channels: ["value"], update: { value: 3 } }),
    );
    withEventThread("wanted", () => bus.emit("run.end", {}));
    expect((await within(first)).value?.type).toBe("state.update");
    expect((await within(iterator.next())).value?.type).toBe("run.end");
    expect((await within(iterator.next())).done).toBe(true);
  });

  it("streams only the current invocation on two consecutive calls to one compiled graph", async () => {
    let count = 0;
    registerFunction("stream-invocation-counter", () => ++count);
    const compiled = await compileGraph(graph());
    const first = await within(collect(compiled.stream({ threadId: "repeat" })));
    expect(first.at(-1)?.type).toBe("run.end");
    const next = collect(compiled.stream({ threadId: "repeat" }));
    let second: FlowgraphEvent[];
    try {
      second = await within(next);
    } finally {
      withEventThread("repeat", () => compiled.events.emit("run.end", {}));
      await next;
    }
    expect(second.filter((event) => event.type === "run.start")).toHaveLength(1);
    expect(
      second
        .filter((event) => event.type === "state.update")
        .map((event) => (event.data as { update: { value: number } }).update.value),
    ).toEqual([2]);
    expect(second.at(-1)?.type).toBe("run.end");
    expect(first.some((event) => event.id === second[0]?.id)).toBe(false);
  });
  it("rejects locally when input fails before execution without broadcasting a terminal event", async () => {
    registerFunction("stream-invocation-counter", () => 1);
    const compiled = await compileGraph(graph());
    const observed: FlowgraphEvent[] = [];
    compiled.events.subscribe((event) => {
      observed.push(event);
    });
    await expect(
      within(collect(compiled.stream({ threadId: "bad-input", input: { __once: {} } }))),
    ).rejects.toThrow(/reserved/i);
    expect(observed.some((event) => event.type === "run.error")).toBe(false);
  });
});
