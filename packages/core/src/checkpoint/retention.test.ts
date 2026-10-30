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
  it("defaults to a bounded policy that stays enabled", () => {
    const r = resolveCheckpointRetention();
    expect(r.enabled).toBe(true);
    expect(r.maxCheckpoints).toBe(40);
    expect(r.maxInterruptPoints).toBe(8);
    expect(r.finishedTtlMs).toBe(14 * 86_400_000);
    expect(r.maxFinishedThreads).toBe(200);
    expect(r.dedupeChannels).toBe(true);
  });

  it("lets the host override the graph and turn retention off", () => {
    const r = resolveCheckpointRetention(
      { maxCheckpoints: 10, finishedTtl: "1d" },
      { maxCheckpoints: 4, enabled: false },
    );
    expect(r.enabled).toBe(false);
    expect(r.maxCheckpoints).toBe(4);
    expect(r.finishedTtlMs).toBe(86_400_000);
  });

  it("treats null ttl and null thread cap as unlimited", () => {
    const r = resolveCheckpointRetention({ finishedTtl: null, maxFinishedThreads: null });
    expect(r.finishedTtlMs).toBeNull();
    expect(r.maxFinishedThreads).toBeNull();
  });

  it("rejects a non-positive checkpoint window by clamping to 1", () => {
    expect(resolveCheckpointRetention({ maxCheckpoints: 0.2 }).maxCheckpoints).toBe(1);
  });
});

describe("retentionStatusForRun", () => {
  it("keeps paused, interrupted, aborted, and exhausted interrupts", () => {
    expect(retentionStatusForRun("paused", false)).toBe("paused");
    expect(retentionStatusForRun("interrupted", true)).toBe("paused");
    expect(retentionStatusForRun("aborted", false)).toBe("paused");
    expect(retentionStatusForRun("error", true)).toBe("paused");
  });

  it("marks a clean completion and a terminal error as finished", () => {
    expect(retentionStatusForRun("completed", false)).toBe("finished");
    expect(retentionStatusForRun("error", false)).toBe("finished");
  });
});
