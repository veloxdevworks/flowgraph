import { describe, expect, it } from "vitest";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph";
import { FlowgraphMemorySaver } from "./memory-saver.js";
import {
  DEFAULT_ACTIVE_TTL_MS,
  abandonedActivePolicy,
  resolveCheckpointRetention,
  type CheckpointRetentionInput,
} from "./retention.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

function checkpoint(id: string, n: number): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(T0).toISOString(),
    channel_values: { n },
    channel_versions: { n },
    versions_seen: {},
  };
}

const meta = (step: number): CheckpointMetadata => ({ source: "loop", step, parents: {} });
const cfg = (threadId: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: "" } });

function saverAt(retention: CheckpointRetentionInput) {
  const clock = { now: T0 };
  const saver = new FlowgraphMemorySaver(resolveCheckpointRetention(retention), undefined, { clock: () => clock.now });
  return { saver, clock };
}

async function write(saver: FlowgraphMemorySaver, threadId: string, step: number): Promise<void> {
  await saver.put(cfg(threadId), checkpoint(`c${String(step).padStart(4, "0")}`, step), meta(step), { n: step });
}

describe("activeTtl resolution", () => {
  it("defaults to seven days and accepts durations, milliseconds and null", () => {
    expect(DEFAULT_ACTIVE_TTL_MS).toBe(7 * DAY);
    expect(resolveCheckpointRetention().activeTtlMs).toBe(7 * DAY);
    expect(resolveCheckpointRetention({ activeTtl: "12h" }).activeTtlMs).toBe(12 * HOUR);
    expect(resolveCheckpointRetention({ activeTtl: 5000 }).activeTtlMs).toBe(5000);
    expect(resolveCheckpointRetention({ activeTtl: null }).activeTtlMs).toBeNull();
    expect(resolveCheckpointRetention({ activeTtl: null }, { activeTtl: "1d" }).activeTtlMs).toBeNull();
    expect(resolveCheckpointRetention({ maxCheckpoints: 3 }, { activeTtl: "1d" }).activeTtlMs).toBe(DAY);
  });

  it("rejects a zero, negative, or malformed limit", () => {
    expect(() => resolveCheckpointRetention({ activeTtl: 0 })).toThrow(/activeTtl/);
    expect(() => resolveCheckpointRetention({ activeTtl: "0s" })).toThrow(/activeTtl/);
    expect(() => resolveCheckpointRetention({ activeTtl: -1 })).toThrow();
    expect(() => resolveCheckpointRetention({ activeTtl: "soon" })).toThrow();
  });

  it("abandons only rows past the limit that this process does not hold", () => {
    const host = resolveCheckpointRetention({ finishedTtl: "1h", activeTtl: "1d" });
    const recorded = { activeTtlMs: DAY, finishedTtlMs: null, maxFinishedThreads: 5 };
    const base = { updatedAt: T0, held: false, recorded, fallback: host };
    expect(abandonedActivePolicy({ ...base, now: T0 + DAY - 1 })).toBeUndefined();
    expect(abandonedActivePolicy({ ...base, now: T0 + DAY })).toEqual(recorded);
    expect(abandonedActivePolicy({ ...base, now: T0 + 30 * DAY, held: true })).toBeUndefined();
    expect(abandonedActivePolicy({ ...base, now: T0 + 30 * DAY, recorded: { ...recorded, activeTtlMs: 0 } })).toBeUndefined();
    // A row stamped before activeTtl existed uses the sweeping saver's policy.
    expect(abandonedActivePolicy({ ...base, recorded: undefined, now: T0 + DAY })).toEqual({
      activeTtlMs: DAY,
      finishedTtlMs: HOUR,
      maxFinishedThreads: null,
    });
    const keepAll = resolveCheckpointRetention({ activeTtl: "1d" });
    expect(abandonedActivePolicy({ ...base, recorded: undefined, fallback: keepAll, now: T0 + 30 * DAY })).toBeUndefined();
  });
});

describe("FlowgraphMemorySaver abandoned active threads", () => {
  it("sweeps an active row whose run stopped past the limit", async () => {
    const { saver, clock } = saverAt({ finishedTtl: "1h", activeTtl: "1d" });
    saver.markThreadActive("crashed");
    await write(saver, "crashed", 1);
    clock.now = T0 + DAY + HOUR;
    await saver.sweep();
    expect(saver.savedThreadStatus("crashed")).toBeUndefined();
    expect(await saver.getTuple(cfg("crashed"))).toBeUndefined();
  });

  it("keeps an active row inside the limit", async () => {
    const { saver } = saverAt({ finishedTtl: "1h", activeTtl: "1d" });
    saver.markThreadActive("recent");
    await write(saver, "recent", 1);
    await saver.sweep(T0 + DAY - 1);
    expect(saver.savedThreadStatus("recent")?.status).toBe("active");
    expect(await saver.getTuple(cfg("recent"))).toBeDefined();
  });

  it("an abandoned row is finished as of its last activity and then follows finishedTtl", async () => {
    const { saver } = saverAt({ finishedTtl: "3d", activeTtl: "1d" });
    saver.markThreadActive("aging");
    await write(saver, "aging", 1);
    await saver.sweep(T0 + 2 * DAY);
    expect(saver.savedThreadStatus("aging")).toEqual({ status: "finished", updatedAt: T0 });
    await saver.sweep(T0 + 3 * DAY - 1);
    expect(await saver.getTuple(cfg("aging"))).toBeDefined();
    await saver.sweep(T0 + 3 * DAY);
    expect(await saver.getTuple(cfg("aging"))).toBeUndefined();
  });

  it("a run that keeps writing checkpoints is never treated as abandoned", async () => {
    const { saver, clock } = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" });
    saver.markThreadActive("live");
    for (let step = 1; step <= 10; step++) {
      clock.now = T0 + step * 20 * HOUR;
      await write(saver, "live", step);
      await saver.sweep(clock.now + 20 * HOUR);
      expect(saver.savedThreadStatus("live")?.status).toBe("active");
    }
    expect(clock.now - T0).toBeGreaterThan(8 * DAY);
    expect((await saver.getTuple(cfg("live")))?.checkpoint.channel_values["n"]).toBe(10);
  });

  it("a run this process holds is kept however old", async () => {
    const { saver } = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: "1d" });
    const token = saver.beginThreadRun("held");
    saver.markThreadActive("held");
    await write(saver, "held", 1);
    await saver.sweep(T0 + 30 * DAY);
    expect(saver.savedThreadStatus("held")?.status).toBe("active");
    saver.endThreadRun("held", "active", token, false, true);
    await saver.sweep(T0 + 30 * DAY);
    expect(saver.savedThreadStatus("held")).toBeUndefined();
  });

  it("activeTtl null keeps an active row until a later run", async () => {
    const { saver } = saverAt({ maxFinishedThreads: 0, finishedTtl: null, activeTtl: null });
    saver.markThreadActive("kept");
    await write(saver, "kept", 1);
    await saver.sweep(T0 + 365 * DAY);
    expect(saver.savedThreadStatus("kept")?.status).toBe("active");
  });

  it("a stale run that wakes after its row was reclaimed does not clobber a newer mark", async () => {
    const { saver, clock } = saverAt({ finishedTtl: null, maxFinishedThreads: 10, activeTtl: "1d" });
    const stale = saver.markThreadActive("woken")!;
    await saver.sweep(T0 + 2 * DAY);
    expect(saver.savedThreadStatus("woken")).toEqual({ status: "finished", updatedAt: T0 });

    clock.now = T0 + 2 * DAY + 1;
    const fresh = saver.markThreadActive("woken")!;
    expect(fresh.prior).toEqual({ status: "finished", updatedAt: T0 });

    // The stale run writes a checkpoint, then gives up. Neither touches the newer mark.
    clock.now += 1;
    await write(saver, "woken", 1);
    saver.restoreThreadStatus("woken", stale.prior, stale.mark);
    expect(saver.savedThreadStatus("woken")?.status).toBe("active");

    // The newer run's own restore still matches its mark.
    saver.restoreThreadStatus("woken", fresh.prior, fresh.mark);
    expect(saver.savedThreadStatus("woken")).toEqual({ status: "finished", updatedAt: T0 });
  });
});
