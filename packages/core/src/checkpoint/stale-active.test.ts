import { beforeAll, describe, expect, it } from "vitest";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { registerFunction } from "../nodes/function.js";
import { FlowgraphMemorySaver } from "./memory-saver.js";
import {
  DEFAULT_ACTIVE_TTL_MS,
  THREAD_MOVED_ON,
  THREAD_WAIT_NOT_RECORDED,
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

/** pre -> gate -> post. `gate` is a human approval, or a breakpoint before `post`. */
function gatedSpec(gate: "approval" | "breakpoint"): GraphSpec {
  const nodes: unknown[] = [{ id: "pre", type: "function", with: { fn: "staleWaitPre", output: { to: "a" } } }];
  const edges: unknown[] = [{ from: "START", to: "pre" }];
  if (gate === "approval") {
    nodes.push({ id: "gate", type: "hitl", with: { mode: "approve", message: "ok?", output: { to: "approval" } } });
    edges.push({ from: "pre", to: "gate" }, { from: "gate", to: "post" });
  } else {
    edges.push({ from: "pre", to: "post" });
  }
  nodes.push({ id: "post", type: "function", with: { fn: "staleWaitPost", output: { to: "b" } } });
  edges.push({ from: "post", to: "END" });
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: `stale-wait-${gate}` },
    state: { channels: { a: { type: "string" }, b: { type: "string" }, approval: { type: "object" } } },
    nodes,
    edges,
    ...(gate === "breakpoint" ? { runtime: { hitl: { breakpoints: { before: ["post"] } } } } : {}),
  } as unknown as GraphSpec;
}

describe("FlowgraphMemorySaver run waiting for an answer", () => {
  const seenInPost: Array<string | undefined> = [];
  let postSaver: FlowgraphMemorySaver | undefined;
  let postThread = "";
  beforeAll(() => {
    registerFunction("staleWaitPre", () => "pre");
    registerFunction("staleWaitPost", () => {
      seenInPost.push(postSaver?.savedThreadStatus(postThread)?.status);
      return "post";
    });
  });

  for (const gate of ["approval", "breakpoint"] as const) {
    it(`stores the row as paused while waiting at ${gate === "approval" ? "an approval" : "a breakpoint"}, then active again under the same mark`, async () => {
      const { saver, clock } = saverAt({ finishedTtl: "1h", activeTtl: "1d" });
      postSaver = saver;
      postThread = `waiting-${gate}`;
      seenInPost.length = 0;
      const graph = await compileGraph(gatedSpec(gate), { checkpointer: saver });
      let whileWaiting: ReturnType<FlowgraphMemorySaver["savedThreadStatus"]>;
      const result = await graph.run({
        threadId: postThread,
        input: {},
        onInterrupt: "prompt",
        resolveInterrupt: async () => {
          whileWaiting = saver.savedThreadStatus(postThread);
          // The answer takes longer than activeTtl. A sweep in the meantime leaves the row.
          clock.now = T0 + 8 * DAY;
          await saver.sweep();
          expect(saver.savedThreadStatus(postThread)?.status).toBe("paused");
          return { approved: true };
        },
      });
      expect(whileWaiting).toEqual({ status: "paused", updatedAt: T0 });
      expect(seenInPost).toEqual(["active"]);
      expect(result.status).toBe("completed");
      expect(result.state["a"]).toBe("pre");
      expect(result.state["b"]).toBe("post");
    });
  }

  it("waiting and answering only apply to the row under the run's own mark", () => {
    const { saver, clock } = saverAt({ finishedTtl: "1h", activeTtl: "1d" });
    const first = saver.markThreadActive("guarded")!;
    expect(saver.noteThreadWaiting("guarded", "someone-else")).toBe(false);
    expect(saver.noteThreadWaiting("guarded", first.mark)).toBe(true);
    expect(saver.noteThreadWaiting("guarded", first.mark)).toBe(false);
    // Another run takes the thread over while the first one waits.
    clock.now = T0 + 1;
    const second = saver.markThreadActive("guarded")!;
    expect(second.prior?.status).toBe("paused");
    expect(saver.noteThreadAnswered("guarded", first.mark)).toBe(false);
    expect(saver.savedThreadStatus("guarded")).toEqual({ status: "active", updatedAt: T0 + 1 });
    expect(saver.noteThreadAnswered("missing", first.mark)).toBe(false);
  });

  it("a restore given the mark time leaves a row written after the mark", async () => {
    const { saver, clock } = saverAt({ finishedTtl: "1h", activeTtl: "1d" });
    const marked = saver.markThreadActive("written")!;
    expect(marked.markedAt).toBe(T0);
    clock.now = T0 + 5;
    await write(saver, "written", 1);
    saver.restoreThreadStatus("written", undefined, marked.mark, marked.markedAt);
    expect(saver.savedThreadStatus("written")).toEqual({ status: "active", updatedAt: T0 + 5 });

    const other = saver.markThreadActive("untouched")!;
    saver.restoreThreadStatus("untouched", undefined, other.mark, other.markedAt);
    expect(saver.savedThreadStatus("untouched")).toBeUndefined();
  });

  it("stops the run before asking when the row cannot be stored as waiting", async () => {
    const { saver, clock } = faultySaverAt();
    saver.failWaiting = true;
    postSaver = saver;
    postThread = "wait-write-fails";
    seenInPost.length = 0;
    const graph = await compileGraph(gatedSpec("approval"), { checkpointer: saver });
    let asked = 0;
    const result = await graph.run({
      threadId: postThread,
      input: {},
      onInterrupt: "prompt",
      resolveInterrupt: async () => {
        asked++;
        return { approved: true };
      },
    });
    expect(result.status).toBe("error");
    expect((result.error as { code?: string }).code).toBe(THREAD_WAIT_NOT_RECORDED);
    expect(result.error?.message).toMatch(/could not be stored as waiting before asking.*disk full/);
    expect(asked).toBe(0);
    expect(seenInPost).toEqual([]);
    // The errored run left the thread paused: a later sweep keeps it, and it resumes.
    expect(saver.savedThreadStatus(postThread)?.status).toBe("paused");
    clock.now = T0 + 8 * DAY;
    await saver.sweep();
    saver.failWaiting = false;
    const resumed = await graph.resume({ threadId: postThread, resume: { approved: true }, onInterrupt: "fail" });
    expect(resumed.status).toBe("completed");
    expect(resumed.state["b"]).toBe("post");
    expect(seenInPost).toEqual(["active"]);
  });

  it("attaches the failed park to the error when the row cannot be stored as paused either", async () => {
    const { saver } = faultySaverAt();
    saver.failWaiting = true;
    saver.failStatus = true;
    postSaver = saver;
    postThread = "db-down";
    seenInPost.length = 0;
    const graph = await compileGraph(gatedSpec("approval"), { checkpointer: saver });
    const result = await graph.run({
      threadId: postThread,
      input: {},
      onInterrupt: "prompt",
      resolveInterrupt: async () => ({ approved: true }),
    });
    expect((result.error as { code?: string }).code).toBe(THREAD_WAIT_NOT_RECORDED);
    expect((result.error as { parkError?: Error }).parkError?.message).toBe("still down");
    // Neither write landed, so the row is still active and a sweep past activeTtl can reclaim it.
    expect(saver.savedThreadStatus(postThread)?.status).toBe("active");
  });

  it("stops the run without applying the answer when the row cannot be stored as active again", async () => {
    const { saver } = faultySaverAt();
    saver.failAnswered = true;
    postSaver = saver;
    postThread = "answer-write-fails";
    seenInPost.length = 0;
    const graph = await compileGraph(gatedSpec("approval"), { checkpointer: saver });
    const result = await graph.run({
      threadId: postThread,
      input: {},
      onInterrupt: "prompt",
      resolveInterrupt: async () => ({ approved: true }),
    });
    expect(result.status).toBe("error");
    expect((result.error as { code?: string }).code).toBe(THREAD_WAIT_NOT_RECORDED);
    expect(result.error?.message).toMatch(/could not be stored as active after the answer/);
    expect(seenInPost).toEqual([]);
    expect(saver.savedThreadStatus(postThread)?.status).toBe("paused");
  });

  it("stops the run before asking when the row is no longer the run's own", async () => {
    const { saver } = faultySaverAt();
    saver.lostBeforeWait = true;
    postSaver = saver;
    postThread = "lost-before-wait";
    seenInPost.length = 0;
    const graph = await compileGraph(gatedSpec("breakpoint"), { checkpointer: saver });
    let asked = 0;
    const result = await graph.run({
      threadId: postThread,
      input: {},
      onInterrupt: "prompt",
      resolveInterrupt: async () => {
        asked++;
        return true;
      },
    });
    expect(result.status).toBe("error");
    expect((result.error as { code?: string }).code).toBe(THREAD_MOVED_ON);
    expect(result.error?.message).toMatch(/before this run could wait for an answer/);
    expect(asked).toBe(0);
    expect(seenInPost).toEqual([]);
  });

  for (const moved of ["taken over", "deleted"] as const) {
    it(`stops the run without applying the answer when the thread was ${moved} while it waited`, async () => {
      const { saver, clock } = saverAt({ finishedTtl: "1h", activeTtl: "1d" });
      postSaver = saver;
      postThread = `moved-on-${moved.replace(" ", "-")}`;
      seenInPost.length = 0;
      const graph = await compileGraph(gatedSpec("approval"), { checkpointer: saver });
      const result = await graph.run({
        threadId: postThread,
        input: {},
        onInterrupt: "prompt",
        resolveInterrupt: async () => {
          clock.now = T0 + 1;
          if (moved === "taken over") saver.markThreadActive(postThread);
          else await saver.deleteThread(postThread);
          return { approved: true };
        },
      });
      expect(result.status).toBe("error");
      expect((result.error as { code?: string }).code).toBe(THREAD_MOVED_ON);
      expect(result.error?.message).toMatch(/while this run waited for an answer/);
      expect(seenInPost).toEqual([]);
      // The stopped run does not write its status over the thread's new owner.
      if (moved === "taken over") expect(saver.savedThreadStatus(postThread)).toEqual({ status: "active", updatedAt: T0 + 1 });
      else expect(saver.savedThreadStatus(postThread)).toBeUndefined();
    });
  }
});

class FaultyMemorySaver extends FlowgraphMemorySaver {
  failWaiting = false;
  failAnswered = false;
  /** Act as if the row stopped being this run's just before the wait. */
  lostBeforeWait = false;
  failStatus = false;
  override async noteThreadStatus(...args: Parameters<FlowgraphMemorySaver["noteThreadStatus"]>): Promise<void> {
    if (this.failStatus) throw new Error("still down");
    return super.noteThreadStatus(...args);
  }
  override noteThreadWaiting(threadId: string, activeMark: string): boolean {
    if (this.failWaiting) throw new Error("disk full");
    if (this.lostBeforeWait) return false;
    return super.noteThreadWaiting(threadId, activeMark);
  }
  override noteThreadAnswered(threadId: string, activeMark: string): boolean {
    if (this.failAnswered) throw new Error("disk full");
    return super.noteThreadAnswered(threadId, activeMark);
  }
}

function faultySaverAt() {
  const clock = { now: T0 };
  const saver = new FaultyMemorySaver(resolveCheckpointRetention({ finishedTtl: "1h", activeTtl: "1d" }), undefined, {
    clock: () => clock.now,
  });
  return { saver, clock };
}
