import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  clearAllReplayCaches,
  clearThreadReplayCache,
  deserializeReplayValue,
  hydrateReplayFromInterruptPayload,
  hydrateThreadReplay,
  replayKeyBelongsTo,
  isGraphInterrupt,
  memoryReplayCache,
  replayCacheKey,
  serializeReplayValue,
  snapshotReplay,
} from "./replay-cache.js";

describe("memoryReplayCache", () => {
  it("stores and retrieves values by key and index", () => {
    clearAllReplayCaches();
    const key = replayCacheKey("thread-1", "agent");
    expect(memoryReplayCache.get(key, "llm:0")).toBeUndefined();
    memoryReplayCache.set(key, "llm:0", { text: "hi" });
    expect(memoryReplayCache.get(key, "llm:0")).toEqual({ text: "hi" });
    memoryReplayCache.clear(key);
    expect(memoryReplayCache.get(key, "llm:0")).toBeUndefined();
  });

  it("isolates keys from each other", () => {
    clearAllReplayCaches();
    memoryReplayCache.set("a", "0", 1);
    memoryReplayCache.set("b", "0", 2);
    expect(memoryReplayCache.get("a", "0")).toBe(1);
    expect(memoryReplayCache.get("b", "0")).toBe(2);
    memoryReplayCache.clear("a");
    expect(memoryReplayCache.get("a", "0")).toBeUndefined();
    expect(memoryReplayCache.get("b", "0")).toBe(2);
    clearAllReplayCaches();
  });

  it("clearThreadReplayCache drops every node key for the thread only", () => {
    clearAllReplayCaches();
    memoryReplayCache.set(replayCacheKey("t1", "agentA"), "tool:0", "a");
    memoryReplayCache.set(replayCacheKey("t1", "agentB"), "llm:0", "b");
    memoryReplayCache.set(replayCacheKey("t2", "agentA"), "tool:0", "c");
    clearThreadReplayCache("t1");
    expect(memoryReplayCache.get(replayCacheKey("t1", "agentA"), "tool:0")).toBeUndefined();
    expect(memoryReplayCache.get(replayCacheKey("t1", "agentB"), "llm:0")).toBeUndefined();
    expect(memoryReplayCache.get(replayCacheKey("t2", "agentA"), "tool:0")).toBe("c");
    clearAllReplayCaches();
  });

  it("clearThreadReplayCache for thread t leaves thread t:x alone", () => {
    clearAllReplayCaches();
    memoryReplayCache.set(replayCacheKey("t", "a"), "tool:0", "mine");
    memoryReplayCache.set(replayCacheKey("t:x", "a"), "tool:0", "other");
    clearThreadReplayCache("t");
    expect(memoryReplayCache.get(replayCacheKey("t", "a"), "tool:0")).toBeUndefined();
    expect(memoryReplayCache.get(replayCacheKey("t:x", "a"), "tool:0")).toBe("other");
    clearAllReplayCaches();
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

describe("hydrateReplayFromInterruptPayload", () => {
  it("loads dump attached to interrupt data", () => {
    clearAllReplayCaches();
    const key = replayCacheKey("t", "agent");
    memoryReplayCache.set(key, "llm:0", { text: "cached" });
    const dump = snapshotReplay(key);
    clearAllReplayCaches();
    hydrateReplayFromInterruptPayload(
      {
        reason: "ask",
        data: { __nodeId: "agent", __agentReplay: { key, entries: dump } },
      },
      "t",
    );
    expect(memoryReplayCache.get(key, "llm:0")).toEqual({ text: "cached" });
    clearAllReplayCaches();
  });

  it("ignores a key for another thread or another node", () => {
    clearAllReplayCaches();
    const entries = { "llm:0": { text: "forged" } };
    // Key of a different thread, though __nodeId matches its node part.
    hydrateReplayFromInterruptPayload({ data: { __nodeId: "agent", __agentReplay: { key: "victim:agent", entries } } }, "attacker");
    // Own thread, but not the node that raised the interrupt.
    hydrateReplayFromInterruptPayload({ data: { __nodeId: "gate", __agentReplay: { key: "attacker:agent", entries } } }, "attacker");
    // No engine node id at all.
    hydrateReplayFromInterruptPayload({ data: { __agentReplay: { key: "attacker:agent", entries } } }, "attacker");
    expect(memoryReplayCache.get("victim:agent", "llm:0")).toBeUndefined();
    expect(memoryReplayCache.get("attacker:agent", "llm:0")).toBeUndefined();
    clearAllReplayCaches();
  });
});

describe("hydrateThreadReplay", () => {
  it("loads only keys of the thread being loaded", () => {
    clearAllReplayCaches();
    const e = { "llm:0": { text: "x" } };
    hydrateThreadReplay("t1", {
      "t1:a": e,
      "t2:a": e,
      "t1:a:b": e, // thread "t1:a", not t1
      "t1": e,
      "t1:": e,
      "xt1:a": e,
    });
    expect(memoryReplayCache.get("t1:a", "llm:0")).toEqual({ text: "x" });
    for (const k of ["t2:a", "t1:a:b", "t1", "t1:", "xt1:a"]) expect(memoryReplayCache.get(k, "llm:0")).toBeUndefined();
    // A thread id containing ":" still owns exactly its own keys.
    hydrateThreadReplay("org:t9", { "org:t9:a": e, "org:a": e });
    expect(memoryReplayCache.get("org:t9:a", "llm:0")).toEqual({ text: "x" });
    expect(memoryReplayCache.get("org:a", "llm:0")).toBeUndefined();
    clearAllReplayCaches();
  });

  it("replayKeyBelongsTo splits at the last colon", () => {
    expect(replayKeyBelongsTo("a:b", "a")).toBe(true);
    expect(replayKeyBelongsTo("a:b:c", "a:b")).toBe(true);
    expect(replayKeyBelongsTo("a:b:c", "a")).toBe(false);
    expect(replayKeyBelongsTo("a:", "a")).toBe(false);
    expect(replayKeyBelongsTo(":b", "")).toBe(false);
  });
});
