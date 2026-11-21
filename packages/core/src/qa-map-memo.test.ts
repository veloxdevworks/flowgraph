import { describe, expect, it } from "vitest";
import { GraphSpecSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
function spec(memoize: unknown = true, inner = {}, rounds = 2) {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "map-memo" },
    state: {
      channels: {
        items: { type: "array" },
        results: { type: "array" },
        round: { type: "number", default: 0 },
      },
    },
    nodes: [
      {
        id: "fan",
        type: "map",
        with: {
          over: "{{ state.items }}",
          as: "n",
          memoize,
          concurrency: 1,
          node: {
            type: "function",
            with: { fn: "memoValue", input: { n: "{{ item.n }}" }, ...inner },
          },
          collect: { to: "results" },
        },
      },
      {
        id: "next",
        type: "function",
        with: {
          fn: "memoNext",
          input: { items: "{{ state.items }}", round: "{{ state.round }}" },
          output: { map: { items: "{{ result.items }}", round: "{{ result.round }}" } },
        },
      },
      {
        id: "route",
        type: "router",
        with: {
          routes: [ { name: "again", when: `{{ state.round < ${rounds} }}`, to: "fan" }, { name: "done", default: true, to: "END" } ],
        },
      },
    ],
    edges: [
      { from: "START", to: "fan" },
      { from: "fan", to: "next" },
      { from: "next", to: "route" },
    ],
  });
}
const next = (input: unknown) => {
  const i = input as { items: number[]; round: number };
  return { ...i, round: i.round + 1 };
};
describe("PLAT-340: map item memoization", () => {
  it("reuses unchanged items after a loop and reorder, recomputing changed items", async () => {
    const seen: number[] = [];
    registerFunction("memoValue", (i) => {
      const n = (i as { n: number }).n;
      seen.push(n);
      return n * 2;
    });
    registerFunction("memoNext", (i) => ({
      round: (i as { round: number }).round + 1,
      items: [3, 1, 4],
    }));
    const result = await (await compileGraph(spec())).run({ input: { items: [1, 2, 3] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([6, 2, 8]);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(Object.keys(result.state).some((k) => k.startsWith("__mapMemo"))).toBe(false);
  });
  it("defaults to running each round and isolates threads", async () => {
    let calls = 0;
    registerFunction("memoValue", () => ++calls);
    registerFunction("memoNext", next);
    await (await compileGraph(spec(false))).run({ input: { items: [1] } });
    expect(calls).toBe(2);
    calls = 0;
    const compiled = await compileGraph(spec());
    await compiled.run({ threadId: "memo-one", input: { items: [1] } });
    await compiled.run({ threadId: "memo-two", input: { items: [1] } });
    expect(calls).toBe(2);
  });
  it("invalidates rendered inputs and explicit dependency keys", async () => {
    let calls = 0;
    registerFunction("memoValue", () => ++calls);
    registerFunction("memoNext", next);
    await (
      await compileGraph(spec(true, { input: { n: "{{ item.n }}", round: "{{ state.round }}" } }))
    ).run({ input: { items: [1] } });
    expect(calls).toBe(2);
    calls = 0;
    await (await compileGraph(spec({ key: "{{ state.round }}" }))).run({ input: { items: [1] } });
    expect(calls).toBe(2);
  });
  it("applies the current output projection to cached raw results", async () => {
    let calls = 0;
    registerFunction("memoValue", () => {
      calls++;
      return 4;
    });
    registerFunction("memoNext", next);
    const result = await (
      await compileGraph(spec(true, { output: { map: { value: "{{ result + state.round }}" } } }))
    ).run({ input: { items: [1] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([{ value: 5 }]);
    expect(calls).toBe(1);
  });
  it("bounds entries and skips oversized results", async () => {
    let calls = 0;
    registerFunction("memoValue", () => ++calls);
    registerFunction("memoNext", next);
    const result = await (
      await compileGraph(spec({ maxEntries: 1 }))
    ).run({ input: { items: [1, 2] } });
    expect(result.status).toBe("completed");
    expect(calls).toBe(3); // only the last first-round item survives
    calls = 0;
    registerFunction("memoValue", () => {
      calls++;
      return "x".repeat(128);
    });
    await (await compileGraph(spec({ maxBytes: 64 }))).run({ input: { items: [1] } });
    expect(calls).toBe(2);
  });
  it("never reuses failed items", async () => {
    let calls = 0;
    registerFunction("memoValue", () => {
      if (++calls === 1) throw new Error("rejected");
      return 7;
    });
    registerFunction("memoNext", next);
    const s = spec();
    s.nodes[0]!.on = { error: "continue" };
    const result = await (await compileGraph(s)).run({ input: { items: [1] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([7]);
    expect(calls).toBe(2);
  });
});
