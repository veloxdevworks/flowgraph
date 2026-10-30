import { describe, it, expect } from "vitest";
import { messagesStateReducer } from "@langchain/langgraph";
import { AIMessage, HumanMessage, RemoveMessage } from "@langchain/core/messages";
import { buildStateAnnotation, channelReducerAndDefault } from "./state-annotation.js";
import { registry } from "../registry.js";
import type { GraphSpec } from "@flowgraph/spec";

const baseSpec = (channels: GraphSpec["state"]): GraphSpec =>
  ({
    metadata: { name: "reducer-test" },
    state: channels,
    nodes: [],
    edges: [],
  }) as unknown as GraphSpec;

describe("channelReducerAndDefault", () => {
  it("lastWrite (default) replaces current with incoming", () => {
    const { reducer } = channelReducerAndDefault("x", { type: "string" });
    expect(reducer("old", "new")).toBe("new");
  });

  it("explicit lastWrite replaces current", () => {
    const { reducer } = channelReducerAndDefault("x", { type: "string", reducer: "lastWrite" });
    expect(reducer("old", "new")).toBe("new");
  });

  it("append concatenates arrays", () => {
    const { reducer } = channelReducerAndDefault("items", { type: "array", reducer: "append" });
    expect(reducer([1], [2])).toEqual([1, 2]);
    expect(reducer([1], 2)).toEqual([1, 2]);
  });

  it("concat concatenates arrays like append", () => {
    const { reducer } = channelReducerAndDefault("items", { type: "array", reducer: "concat" });
    expect(reducer(["a"], ["b"])).toEqual(["a", "b"]);
  });

  it("merge shallow-merges objects", () => {
    const { reducer } = channelReducerAndDefault("ctx", { type: "object", reducer: "merge" });
    expect(reducer({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(reducer({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("mergeDeep deep-merges nested objects", () => {
    const { reducer } = channelReducerAndDefault("ctx", { type: "object", reducer: "mergeDeep" });
    expect(reducer({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 } });
    expect(reducer({ a: { x: 1 } }, { a: { x: 2 } })).toEqual({ a: { x: 2 } });
  });

  it("messages type behaves like LangGraph messagesStateReducer", () => {
    const { reducer, default: defaultFn } = channelReducerAndDefault("messages", { type: "messages" });
    expect(defaultFn()).toEqual([]);
    const cur = [new HumanMessage({ content: "a", id: "1" }), new AIMessage({ content: "b", id: "2" })];
    const inc = [new AIMessage({ content: "b2", id: "2" }), new HumanMessage({ content: "c", id: "3" })];
    expect(reducer(cur, inc)).toEqual(messagesStateReducer(cur, inc));
    const removed = reducer(cur, [new RemoveMessage({ id: "1" })]) as Array<{ id: string }>;
    expect(removed.map((m) => m.id)).toEqual(["2"]);
  });

  it("messages reducer ignores removals of ids that are not in the channel", () => {
    const { reducer } = channelReducerAndDefault("chat", {
      type: "array",
      reducer: "messages",
    });
    const cur = [new HumanMessage({ content: "a", id: "1" }), new AIMessage({ content: "b", id: "2" })];
    expect(() => messagesStateReducer(cur, [new RemoveMessage({ id: "gone" })])).toThrow();
    const out = reducer(cur, [new RemoveMessage({ id: "gone" }), new RemoveMessage({ id: "2" }), new RemoveMessage({ id: "2" })]) as Array<{ id: string }>;
    expect(out.map((m) => m.id)).toEqual(["1"]);
    expect(reducer(cur, [new RemoveMessage({ id: "__remove_all__" })])).toEqual([]);
  });

  it("custom reducer merges via registered function", () => {
    const name = "testUniqueByIdReducer";
    if (!registry.getReducer(name)) {
      registry.registerReducer(name, (cur: unknown, inc: unknown) => {
        const items = [...((cur as { id: string }[] | undefined) ?? []), ...((inc as { id: string }[]) ?? [])];
        const map = new Map(items.map((i) => [i.id, i]));
        return [...map.values()];
      });
    }

    const { reducer } = channelReducerAndDefault("findings", {
      type: "array",
      reducer: `custom:${name}`,
    });
    const r1 = reducer([{ id: "a", v: 1 }], [{ id: "b", v: 2 }]) as { id: string; v: number }[];
    expect(r1).toHaveLength(2);
    const r2 = reducer(r1, [{ id: "a", v: 3 }]) as { id: string; v: number }[];
    expect(r2).toHaveLength(2);
    expect(r2.find((i) => i.id === "a")?.v).toBe(3);
  });

  it("throws when custom reducer is not registered", () => {
    expect(() =>
      channelReducerAndDefault("findings", {
        type: "array",
        reducer: "custom:missingReducer",
      }),
    ).toThrow(/no reducer is registered under that name/);
  });
});

describe("buildStateAnnotation", () => {
  it("builds annotation with custom reducer channel", () => {
    const name = "testBuildCustomReducer";
    if (!registry.getReducer(name)) {
      registry.registerReducer(name, (cur, inc) => {
        const items = [...((cur as unknown[] | undefined) ?? []), ...((inc as unknown[] | undefined) ?? [])];
        return items;
      });
    }
    const spec = baseSpec({
      channels: {
        findings: { type: "array", reducer: `custom:${name}` },
      },
    });
    expect(() => buildStateAnnotation(spec)).not.toThrow();
  });

  it("throws at build time for unregistered custom reducer", () => {
    const spec = baseSpec({
      channels: {
        bad: { type: "array", reducer: "custom:definitelyNotRegistered_xyz" },
      },
    });
    expect(() => buildStateAnnotation(spec)).toThrow(/definitelyNotRegistered_xyz/);
  });
});
