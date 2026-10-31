import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  ReplayStore,
  RUN_SCOPE_KEY,
  childRunConfig,
  deserializeReplayValue,
  isGraphInterrupt,
  replayNodeKey,
  replayStoreFromInterrupts,
  runScopeOf,
  serializeReplayValue,
} from "./replay-cache.js";

describe("ReplayStore", () => {
  it("stores, reads and clears one node's entries", () => {
    const store = new ReplayStore();
    const key = replayNodeKey([], "agent");
    expect(store.get(key, "llm:0")).toBeUndefined();
    store.set(key, "llm:0", { text: "hi" });
    expect(store.get(key, "llm:0")).toEqual({ text: "hi" });
    store.clear(key);
    expect(store.get(key, "llm:0")).toBeUndefined();
  });

  it("two stores never share entries", () => {
    const a = new ReplayStore();
    const b = new ReplayStore();
    const key = replayNodeKey([], "agent");
    a.set(key, "llm:0", "a");
    expect(b.get(key, "llm:0")).toBeUndefined();
  });

  it("snapshot and load round-trip an AIMessage", () => {
    const store = new ReplayStore();
    const key = replayNodeKey(["sg"], "a");
    store.set(key, "llm:0", new AIMessage({ content: "x", tool_calls: [{ name: "t", args: {}, id: "1" }] }));
    const copy = new ReplayStore();
    copy.load(key, store.snapshot(key));
    expect(copy.get(key, "llm:0")).toBeInstanceOf(AIMessage);
  });
});

describe("replayNodeKey", () => {
  it("keeps a child node apart from a parent node of the same id", () => {
    expect(replayNodeKey([], "a")).not.toBe(replayNodeKey(["sg"], "a"));
    expect(replayNodeKey(["sg"], "a")).not.toBe(replayNodeKey(["s"], "ga"));
  });

  it("requires a node id", () => {
    expect(() => replayNodeKey([], "")).toThrow(/node id/);
  });
});

describe("run scope in the invoke config", () => {
  it("is read back from configurable and nests under a subgraph node", () => {
    const replay = new ReplayStore();
    const config = { configurable: { thread_id: "t", [RUN_SCOPE_KEY]: { replay, path: [] } } };
    expect(runScopeOf(config)?.replay).toBe(replay);
    const child = childRunConfig(config, "sg");
    expect(runScopeOf(child)?.path).toEqual(["sg"]);
    expect(runScopeOf(child)?.replay).toBe(replay);
    expect(runScopeOf(config)?.path).toEqual([]);
    expect(child.configurable.thread_id).toBe("t");
  });

  it("ignores a value that is not a run scope", () => {
    expect(runScopeOf({ configurable: { [RUN_SCOPE_KEY]: { replay: {}, path: [] } } })).toBeUndefined();
    expect(runScopeOf(undefined)).toBeUndefined();
  });
});

describe("replayStoreFromInterrupts", () => {
  const entries = { "llm:0": { text: "cached" } };

  it("loads the snapshot of the interrupting node", () => {
    const node = replayNodeKey(["sg"], "a");
    const store = replayStoreFromInterrupts([{ reason: "ok?", data: { __nodeId: "a", __agentReplay: { node, entries } } }]);
    expect(store.get(node, "llm:0")).toEqual({ text: "cached" });
  });

  it("ignores snapshots that name another node or are malformed", () => {
    const store = replayStoreFromInterrupts([
      { data: { __nodeId: "gate", __agentReplay: { node: replayNodeKey([], "a"), entries } } },
      { data: { __agentReplay: { node: replayNodeKey([], "a"), entries } } },
      { data: { __nodeId: "a", __agentReplay: { node: "t:a", entries } } },
      { data: { __nodeId: "a", __agentReplay: { node: "[]", entries } } },
      { data: { __nodeId: "a", __agentReplay: { node: replayNodeKey([], "a"), entries: "x" } } },
      { __nodeId: "a", __agentReplay: { node: replayNodeKey([], "a"), entries } },
      null,
    ]);
    expect(store.has(replayNodeKey([], "a"))).toBe(false);
    expect(store.has("t:a")).toBe(false);
  });
});

describe("isGraphInterrupt", () => {
  it("detects GraphInterrupt-shaped errors", () => {
    const err = Object.assign(new Error("interrupt"), { name: "GraphInterrupt" });
    expect(isGraphInterrupt(err)).toBe(true);
    expect(isGraphInterrupt(new Error("nope"))).toBe(false);
  });
});

describe("serializeReplayValue", () => {
  it("round-trips LangChain AIMessage", () => {
    const msg = new AIMessage({ content: "hi", tool_calls: [{ name: "t", args: {}, id: "1" }] });
    const ser = serializeReplayValue(msg);
    const back = deserializeReplayValue(ser);
    expect(back).toBeInstanceOf(AIMessage);
    expect((back as AIMessage).content).toBe("hi");
  });
});
