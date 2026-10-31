import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  ReplayStore,
  RUN_SCOPE_KEY,
  childRunConfig,
  deserializeReplayValue,
  isGraphInterrupt,
  replayNodeKey,
  recordedToolResult,
  ReplayMismatchError,
  replayedToolResult,
  replayStoreFromInterrupts,
  runScopeOf,
  toolArgsHash,
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

describe("replay entries of nodes called as tools", () => {
  const entries = { "llm:0": { text: "cached" } };
  const owner = replayNodeKey([], "o");
  const below = (...rest: string[]) => JSON.stringify(["o", ...rest]);

  it("snapshots a node with the nodes it called as tools, and nothing beside it", () => {
    const store = new ReplayStore();
    store.set(owner, "llm:0", 1);
    store.set(below("tool:0", "h"), "llm:0", 2);
    store.set(below("tool:0", "h", "tool:1", "g"), "llm:0", 3);
    store.set(JSON.stringify(["other"]), "llm:0", 4);
    store.set(JSON.stringify(["ox"]), "llm:0", 5);
    expect(store.snapshotUnder(owner).map((s) => s.node).sort()).toEqual([owner, below("tool:0", "h"), below("tool:0", "h", "tool:1", "g")].sort());
  });

  it("loads nested entries below the replay root whose path the engine could produce", () => {
    const ok = [
      below("tool:0", "h"),
      below("tool:3", "h", "tool:0", "g"),
      below("tool:0", "sg", "a"),
      below("tool:1", "sg", "m[2]", "a", "tool:0", "t", "b"),
      below("sg", "a"),
      below("m[0]"),
    ];
    const bad = [
      JSON.stringify(["p", "tool:0", "h"]),
      below("tool:0"),
      below("tool:0", "tool:1", "h"),
      below("tool:x", "h"),
      below("tool:01x", "h"),
      below("a[x]"),
      below("a]"),
      below("a\u0001"),
      below(""),
      below("x".repeat(257)),
      below(...Array.from({ length: 64 }, () => "s")),
      JSON.stringify(["o", 1]),
      JSON.stringify(["o"]),
      "not json",
    ];
    const store = replayStoreFromInterrupts([
      { data: { __nodeId: "o", __agentReplay: { node: owner, entries, nested: [...ok, ...bad].map((node) => ({ node, entries })) } } },
      // A nested list on a snapshot that does not belong to its interrupt is ignored too.
      { data: { __nodeId: "gate", __agentReplay: { node: owner, entries, nested: [{ node: below("tool:9", "z"), entries }] } } },
    ]);
    for (const k of ok) expect(store.has(k), k).toBe(true);
    for (const k of [...bad.filter((k) => k !== JSON.stringify(["o"])), below("tool:9", "z")]) expect(store.has(k), k).toBe(false);
  });

  it("loads a root saved by an interrupt raised below it, where the raising node is", () => {
    const raised = (at: unknown, nodeId = "a", node: unknown = owner) => ({ data: { __nodeId: nodeId, __agentReplay: { node, at, entries } } });
    expect(replayStoreFromInterrupts([raised(below("tool:0", "sg", "a"))]).has(owner)).toBe(true);
    for (const value of [
      raised(below("tool:0", "sg", "b")),
      raised(JSON.stringify(["p", "tool:0", "a"])),
      raised(below("tool:0", "tool:1", "a")),
      raised("not json"),
      raised(below("tool:0", "sg", "a"), "a", JSON.stringify(["tool:0", "a"])),
      raised(below("tool:0", "sg", "a"), "a", JSON.stringify(["o", "tool:0"])),
    ]) {
      expect(replayStoreFromInterrupts([value]).has(owner), JSON.stringify(value)).toBe(false);
    }
  });

  it("loads a snapshot only under the task that raised the interrupt", () => {
    const value = (node: string, nodeId: string) => ({ data: { __nodeId: nodeId, __agentReplay: { node, entries } } });
    const map = replayNodeKey([], "m[1]");
    const tasks = (name: string) => [(root: string) => root === name];
    expect(replayStoreFromInterrupts([value(owner, "o")], { taskRoots: tasks("o") }).has(owner)).toBe(true);
    expect(replayStoreFromInterrupts([value(owner, "o")], { taskRoots: tasks("other") }).has(owner)).toBe(false);
    expect(replayStoreFromInterrupts([value(owner, "o")], { taskRoots: [] }).has(owner)).toBe(false);
    expect(replayStoreFromInterrupts([value(map, "m[1]")], { taskRoots: tasks("m[1]") }).has(map)).toBe(true);
  });
});

describe("cached tool results", () => {
  it("hashes arguments independently of key order", () => {
    expect(toolArgsHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(toolArgsHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(toolArgsHash({ a: 1 })).not.toBe(toolArgsHash({ a: 2 }));
    expect(toolArgsHash({ a: 1 })).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a result recorded for the same call and refuses one recorded for another", () => {
    const cached = recordedToolResult("lookup", { q: "x" }, { hit: 1 });
    expect(replayedToolResult(cached, "lookup", { q: "x" }, "agent node \"a\" tool:0")).toEqual({ hit: 1 });
    for (const [tool, args] of [["lookup", { q: "y" }], ["other", { q: "x" }]] as const) {
      let err: unknown;
      try {
        replayedToolResult(cached, tool, args, "agent node \"a\" tool:0");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ReplayMismatchError);
      expect((err as ReplayMismatchError).code).toBe("REPLAY_MISMATCH");
      expect((err as Error).message).toContain("agent node \"a\" tool:0");
    }
  });

  it("reuses a bare result saved by an earlier release as it is", () => {
    expect(replayedToolResult({ hit: 1 }, "lookup", { q: "x" }, "a")).toEqual({ hit: 1 });
    expect(replayedToolResult("text", "lookup", {}, "a")).toBe("text");
  });
});

describe("replay snapshots saved by an earlier release", () => {
  const entries = { "llm:0": { text: "cached" } };

  it("loads an interrupt saved by an earlier release for its own thread and node only", () => {
    const legacy = (key: string, nodeId = "a") => ({ data: { __nodeId: nodeId, __agentReplay: { key, entries } } });
    const store = replayStoreFromInterrupts([legacy("t1:a")], { threadId: "t1" });
    expect(store.get(replayNodeKey([], "a"), "llm:0")).toEqual({ text: "cached" });
    for (const [values, threadId] of [
      [[legacy("t2:a")], "t1"],
      [[legacy("t1:b")], "t1"],
      [[legacy("t1:a", "b")], "t1"],
      [[legacy(":a")], ""],
      [[legacy("t1:a")], undefined],
      [[{ data: { __nodeId: "a", __agentReplay: { key: "t1:a", node: replayNodeKey(["x"], "y"), entries } } }], "t1"],
    ] as const) {
      const other = replayStoreFromInterrupts(values as unknown as unknown[], { threadId });
      expect(other.has(replayNodeKey([], "a")) || other.has(replayNodeKey([], "b")), JSON.stringify(values)).toBe(false);
    }
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
