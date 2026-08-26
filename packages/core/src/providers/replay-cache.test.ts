import { describe, expect, it } from "vitest";
import {
  clearAllReplayCaches,
  clearThreadReplayCache,
  isGraphInterrupt,
  memoryReplayCache,
  replayCacheKey,
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
});

describe("isGraphInterrupt", () => {
  it("detects GraphInterrupt-shaped errors", () => {
    const err = Object.assign(new Error("interrupt"), { name: "GraphInterrupt" });
    expect(isGraphInterrupt(err)).toBe(true);
    expect(isGraphInterrupt(new Error("nope"))).toBe(false);
  });
});
