import { describe, expect, it } from "vitest";
import {
  resolveCheckpointRetention,
  retentionStatusForRun,
  selectRetainedCheckpointIds,
} from "./retention.js";

describe("selectRetainedCheckpointIds", () => {
  const ids = ["e", "d", "c", "b", "a"];

  it("keeps the newest window and the head", () => {
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ids,
      maxCheckpoints: 2,
      interruptIds: [],
      explicitPinsNewestFirst: [],
      maxInterruptPoints: 8,
    });
    expect([...keep]).toEqual(["e", "d"]);
  });

  it("pins interrupt and resume points outside the window, newest first, up to the cap", () => {
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ids,
      maxCheckpoints: 1,
      interruptIds: ["a", "c", "b"],
      explicitPinsNewestFirst: ["a"],
      maxInterruptPoints: 2,
    });
    // head "e", then newest interrupt pins "c" and "b" ("a" is older)
    expect(keep.has("e")).toBe(true);
    expect(keep.has("c")).toBe(true);
    expect(keep.has("b")).toBe(true);
    expect(keep.has("a")).toBe(false);
    expect(keep.size).toBe(3);
  });

  it("does not spend the pin budget on checkpoints already in the window", () => {
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ids,
      maxCheckpoints: 2,
      interruptIds: ["e", "d", "a"],
      explicitPinsNewestFirst: [],
      maxInterruptPoints: 1,
    });
    expect(keep.has("e")).toBe(true);
    expect(keep.has("d")).toBe(true);
    expect(keep.has("a")).toBe(true);
  });

  it("always keeps the newest checkpoint", () => {
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ["only"],
      maxCheckpoints: 1,
      interruptIds: [],
      explicitPinsNewestFirst: [],
      maxInterruptPoints: 0,
    });
    expect([...keep]).toEqual(["only"]);
  });
});

describe("resolveCheckpointRetention", () => {
  it("defaults to pruning and dedupe, with thread deletion off", () => {
    const r = resolveCheckpointRetention();
    expect(r.enabled).toBe(true);
    expect(r.maxCheckpoints).toBe(40);
    expect(r.maxInterruptPoints).toBe(8);
    expect(r.finishedTtlMs).toBeNull();
    expect(r.maxFinishedThreads).toBeNull();
    expect(r.dedupeChannels).toBe(true);
    expect(r.vacuum).toBe("auto");
  });

  it("lets the graph override the host, including an opt-out", () => {
    const r = resolveCheckpointRetention(
      { maxCheckpoints: 10, finishedTtl: "1d" },
      { maxCheckpoints: 4, enabled: false },
    );
    expect(r.enabled).toBe(true);
    expect(r.maxCheckpoints).toBe(10);
    expect(r.finishedTtlMs).toBe(86_400_000);
    expect(resolveCheckpointRetention(false, { maxCheckpoints: 4 }).enabled).toBe(false);
  });

  it("rejects a negative finished-thread cap", () => {
    expect(() => resolveCheckpointRetention({ maxFinishedThreads: -1 })).toThrow(/maxFinishedThreads/);
  });

  it("treats null ttl and null thread cap as unlimited", () => {
    const r = resolveCheckpointRetention({ finishedTtl: null, maxFinishedThreads: null });
    expect(r.finishedTtlMs).toBeNull();
    expect(r.maxFinishedThreads).toBeNull();
  });

  it("rejects out-of-range checkpoint and interrupt windows", () => {
    expect(() => resolveCheckpointRetention({ maxCheckpoints: 0 })).toThrow(/maxCheckpoints/);
    expect(() => resolveCheckpointRetention({ maxCheckpoints: 0.2 })).toThrow(/maxCheckpoints/);
    expect(() => resolveCheckpointRetention({ maxCheckpoints: -3 })).toThrow(/maxCheckpoints/);
    expect(() => resolveCheckpointRetention({ maxInterruptPoints: -1 })).toThrow(/maxInterruptPoints/);
    expect(() => resolveCheckpointRetention({ maxInterruptPoints: 1.5 })).toThrow(/maxInterruptPoints/);
    expect(resolveCheckpointRetention({ maxInterruptPoints: 0 }).maxInterruptPoints).toBe(0);
    expect(resolveCheckpointRetention({ maxCheckpoints: 1 }).maxCheckpoints).toBe(1);
    expect(() => resolveCheckpointRetention({ maxCheckpoints: "40" as unknown as number })).toThrow(/"40"/);
    expect(() => resolveCheckpointRetention({ maxCheckpoints: 1e300 })).toThrow(/maxCheckpoints/);
    expect(() => resolveCheckpointRetention({ maxInterruptPoints: 1e300 })).toThrow(/maxInterruptPoints/);
  });
});

describe("retentionStatusForRun", () => {
  it("keeps paused, interrupted, aborted, and errored runs", () => {
    expect(retentionStatusForRun("paused")).toBe("paused");
    expect(retentionStatusForRun("interrupted")).toBe("paused");
    expect(retentionStatusForRun("aborted")).toBe("paused");
    expect(retentionStatusForRun("error")).toBe("paused");
  });

  it("marks only a completed run as finished", () => {
    expect(retentionStatusForRun("completed")).toBe("finished");
  });
});

describe("selectRetainedCheckpointIds branches", () => {
  it("counts the window separately on each fork", () => {
    const parentOf = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
      ["d", "a"],
    ]);
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ["d", "c", "b", "a"],
      parentOf,
      maxCheckpoints: 1,
      interruptIds: [],
      explicitPinsNewestFirst: [],
      maxInterruptPoints: 0,
    });
    expect(keep.has("c")).toBe(true);
    expect(keep.has("d")).toBe(true);
    expect(keep.has("b")).toBe(false);
    expect(keep.has("a")).toBe(false);
  });
});
