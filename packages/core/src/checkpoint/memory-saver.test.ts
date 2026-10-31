import { describe, expect, it } from "vitest";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { registerFunction } from "../nodes/function.js";
import { FlowgraphMemorySaver } from "./memory-saver.js";
import { CHECKPOINT_PRUNED, resolveCheckpointRetention, retentionStatusForRun } from "./retention.js";

registerFunction("retTag", (input) => {
  const raw = (input as { n?: unknown } | undefined)?.n;
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(n) ? n + 1 : 1;
});

function meta(step: number): CheckpointMetadata {
  return { source: "loop", step, parents: {} };
}

function checkpoint(id: string, values: Record<string, unknown>, versions: Record<string, number>): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: values,
    channel_versions: versions,
    versions_seen: {},
  };
}

const config = (threadId: string, checkpointId?: string) => ({
  configurable: {
    thread_id: threadId,
    checkpoint_ns: "",
    ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
  },
});

describe("FlowgraphMemorySaver retention", () => {
  it("stores an unchanged channel once and still returns it", async () => {
    const saver = new FlowgraphMemorySaver(resolveCheckpointRetention({ maxCheckpoints: 20, finishedTtl: null }));
    const pad = "p".repeat(8000);
    await saver.put(config("t"), checkpoint("b", { pad, n: 1 }, { pad: 1, n: 1 }), meta(1), { pad: 1, n: 1 });
    await saver.put(config("t", "b"), checkpoint("c", { pad, n: 2 }, { pad: 1, n: 2 }), meta(2), { n: 2 });
    await saver.put(config("t", "c"), checkpoint("d", { pad, n: 3 }, { pad: 1, n: 3 }), meta(3), { n: 3 });
    const tuple = await saver.getTuple(config("t"));
    expect(tuple?.checkpoint.channel_values["pad"]).toBe(pad);
    expect(tuple?.checkpoint.channel_values["n"]).toBe(3);
    expect(saver.storedVersions("t", "", "pad")).toEqual(["1"]);
    const doubled = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ maxCheckpoints: 20, dedupeChannels: false, finishedTtl: null }),
    );
    await doubled.put(config("t"), checkpoint("b", { pad, n: 1 }, { pad: 1, n: 1 }), meta(1), { pad: 1, n: 1 });
    await doubled.put(config("t", "b"), checkpoint("c", { pad, n: 2 }, { pad: 1, n: 2 }), meta(2), { n: 2 });
    await doubled.put(config("t", "c"), checkpoint("d", { pad, n: 3 }, { pad: 1, n: 3 }), meta(3), { n: 3 });
    expect(saver.byteSize()).toBeLessThan(doubled.byteSize());
  });

  it("keeps writes stored before their checkpoint and drops them once a successor exists", async () => {
    const saver = new FlowgraphMemorySaver(resolveCheckpointRetention({ maxCheckpoints: 20, finishedTtl: null }));
    await saver.putWrites(config("early", "leaf"), [["__interrupt__", { reason: "wait" }]], "task");
    await saver.put(config("early"), checkpoint("other", { n: 1 }, { n: 1 }), meta(1));
    await saver.put(config("early"), checkpoint("leaf", { n: 2 }, { n: 2 }), meta(2));
    const leaf = await saver.getTuple(config("early", "leaf"));
    expect(leaf?.pendingWrites?.some((write) => write[1] === "__interrupt__")).toBe(true);

    await saver.put(config("done"), checkpoint("p", { n: 1 }, { n: 1 }), meta(1));
    await saver.putWrites(config("done", "p"), [["n", "payload"]], "task");
    await saver.put(config("done", "p"), checkpoint("c", { n: 2 }, { n: 2 }), meta(2));
    const parent = await saver.getTuple(config("done", "p"));
    expect(parent?.pendingWrites ?? []).toEqual([]);
    const child = await saver.getTuple(config("done", "c"));
    expect(child?.checkpoint.channel_values["n"]).toBe(2);
  });

  it("keeps the newest checkpoints and an older interrupt point", async () => {
    const saver = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ maxCheckpoints: 1, maxInterruptPoints: 2, finishedTtl: null, maxFinishedThreads: null }),
    );
    await saver.put(config("t"), checkpoint("a", { n: "a" }, { n: 1 }), meta(1));
    await saver.putWrites(config("t", "a"), [["__interrupt__", { reason: "wait" }]], "task-1");
    for (const id of ["b", "c", "d", "e", "f"]) {
      const parent = String.fromCharCode(id.charCodeAt(0) - 1);
      await saver.put(config("t", parent), checkpoint(id, { n: id }, { n: id.charCodeAt(0) }), meta(id.charCodeAt(0)));
    }
    const kept = Object.keys(saver.storage["t"]?.[""] ?? {}).sort();
    expect(kept).toContain("f");
    expect(kept).toContain("a");
    expect(kept).not.toContain("b");
    const loaded = await saver.getTuple(config("t", "a"));
    expect(loaded?.checkpoint.channel_values["n"]).toBe("a");
    expect(loaded?.pendingWrites?.some((write) => write[1] === "__interrupt__")).toBe(true);
  });

  it("drops finished threads past the cap and keeps a paused thread", async () => {
    const saver = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ maxCheckpoints: 5, maxFinishedThreads: 1, finishedTtl: null }),
    );
    await saver.put(config("old"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
    await saver.noteThreadStatus("old", "finished", 1);
    await saver.put(config("mid"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
    await saver.noteThreadStatus("mid", "finished", 2);
    await saver.put(config("paused"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
    await saver.putWrites(config("paused", "1"), [["__interrupt__", { reason: "wait" }]], "task");
    await saver.noteThreadStatus("paused", "paused", 3);
    expect(saver.storage["old"]).toBeUndefined();
    expect(saver.storage["mid"]).toBeDefined();
    expect(saver.storage["paused"]).toBeDefined();
    const paused = await saver.getTuple(config("paused"));
    expect(paused?.checkpoint.channel_values["n"]).toBe(1);
  });

  it("keeps an errored or aborted thread even when finished threads are deleted immediately", async () => {
    const saver = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ maxFinishedThreads: 0, finishedTtl: "1ms" }),
    );
    await saver.put(config("err"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
    await saver.noteThreadStatus("err", retentionStatusForRun("error"), 1);
    await saver.put(config("abort"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
    await saver.noteThreadStatus("abort", retentionStatusForRun("aborted"), 1);
    await saver.sweep(Date.now() + 60_000);
    expect(saver.storage["err"]).toBeDefined();
    expect(saver.storage["abort"]).toBeDefined();
  });
});

function interruptSpec(): GraphSpec {
  return {
    metadata: { name: "retain-hitl" },
    state: { channels: { tag: { type: "string" } } },
    nodes: [
      { id: "gate", type: "wait", with: { signal: "go" } },
      { id: "a", type: "function", with: { fn: "retTag", input: { n: "1" }, output: { to: "tag" } } },
      { id: "b", type: "function", with: { fn: "retTag", input: { n: "2" }, output: { to: "tag" } } },
      { id: "c", type: "function", with: { fn: "retTag", input: { n: "3" }, output: { to: "tag" } } },
      { id: "d", type: "function", with: { fn: "retTag", input: { n: "4" }, output: { to: "tag" } } },
      { id: "e", type: "function", with: { fn: "retTag", input: { n: "5" }, output: { to: "tag" } } },
    ],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "d", to: "e" },
      { from: "e", to: "END" },
    ],
    runtime: {
      checkpoint: {
        enabled: true,
        backend: "memory",
        retention: { maxCheckpoints: 2, maxInterruptPoints: 4, finishedTtl: null, maxFinishedThreads: null },
      },
    },
  } as unknown as GraphSpec;
}

describe("resume after checkpoint pruning", () => {
  it("resumes a paused thread and can resume again from the interrupt checkpoint", async () => {
    const compiled = await compileGraph(interruptSpec(), { checkpointer: "memory" });
    const threadId = "retain-resume";
    const paused = await compiled.run({ threadId, onInterrupt: "fail" });
    expect(paused.status).toBe("interrupted");
    const snap = await compiled.getState(threadId);
    const interruptId = snap?.checkpointId;
    expect(interruptId).toBeTruthy();

    const done = await compiled.resume({ threadId, resume: { go: true }, onInterrupt: "fail" });
    expect(done.status).toBe("completed");
    expect(done.state["tag"]).toBe(6);

    const history = await compiled.getStateHistory(threadId);
    expect(history.length).toBeLessThanOrEqual(2 + 4);
    expect(history.some((item) => item.checkpointId === interruptId)).toBe(true);

    const again = await compiled.resumeFrom({
      threadId,
      checkpointId: interruptId!,
      resume: { go: true },
      onInterrupt: "fail",
    });
    expect(again.status).toBe("completed");
    expect(again.state["tag"]).toBe(6);
  });

  it("returns CHECKPOINT_PRUNED when the requested checkpoint was dropped", async () => {
    const saver = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ maxCheckpoints: 1, maxInterruptPoints: 0, finishedTtl: "1h" }),
    );
    const spec = {
      metadata: { name: "pruned-id" },
      state: { channels: { n: { type: "number" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "retTag", output: { to: "n" } } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    const compiled = await compileGraph(spec, { checkpointer: saver });
    const threadId = "pruned-id";
    await compiled.run({ threadId, input: { n: 1 }, onInterrupt: "fail" });
    const first = (await compiled.getState(threadId))?.checkpointId;
    expect(first).toBeTruthy();
    await compiled.run({ threadId, input: { n: 2 }, onInterrupt: "fail" });
    const again = await compiled.resumeFrom({
      threadId,
      checkpointId: first!,
      resume: true,
      onInterrupt: "fail",
    });
    expect(again.status).toBe("error");
    expect((again.error as { code?: string; message?: string } | undefined)?.code).toBe(CHECKPOINT_PRUNED);
    expect((again.error as { message?: string } | undefined)?.message).toMatch(/missing or was pruned/);
    expect((again.error as { message?: string } | undefined)?.message).not.toMatch(/Retention pruned it/);
    const row = (saver as unknown as { threads: Map<string, { status: string }> }).threads.get(threadId);
    expect(row?.status).toBe("finished");
    await saver.sweep(Date.now() + 2 * 60 * 60 * 1000);
    expect(saver.storage[threadId]).toBeUndefined();
  });

  it("does not mention retention when a missing checkpoint is resumed with retention off", async () => {
    const saver = new FlowgraphMemorySaver(false);
    const spec = {
      metadata: { name: "pruned-off" },
      state: { channels: { n: { type: "number" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "retTag", output: { to: "n" } } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    const compiled = await compileGraph(spec, { checkpointer: saver });
    const missing = await compiled.resumeFrom({
      threadId: "absent",
      checkpointId: "missing",
      resume: true,
      onInterrupt: "fail",
    });
    expect(missing.status).toBe("error");
    expect((missing.error as { code?: string; message?: string }).code).toBe(CHECKPOINT_PRUNED);
    expect((missing.error as { message?: string }).message).not.toMatch(/[Rr]etention/);
  });
});

describe("thread run guard", () => {
  it("a sweep skips a parked interrupt, and deleteThread still removes it", async () => {
    for (const retention of [resolveCheckpointRetention({ maxFinishedThreads: 0, finishedTtl: null }), false as const]) {
      const saver = new FlowgraphMemorySaver(retention);
      await saver.put(config("waiting"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
      const parked = saver.beginThreadRun("waiting");
      saver.endThreadRun("waiting", "paused", parked);
      const other = saver.beginThreadRun("waiting");
      saver.endThreadRun("waiting", "finished", other, false);
      expect(saver.storage["waiting"]).toBeDefined();
      await saver.deleteThread("waiting");
      expect(saver.storage["waiting"]).toBeUndefined();
    }
  });

  it("a finishing run does not clear another run's parked interrupt", async () => {
    const saver = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ maxFinishedThreads: 0, finishedTtl: null }),
    );
    await saver.put(config("waiting"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
    const parked = saver.beginThreadRun("waiting");
    saver.endThreadRun("waiting", "paused", parked);
    await saver.noteThreadStatus("waiting", "finished");
    expect(saver.storage["waiting"]).toBeDefined();
    await saver.put(config("other"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
    const finished = saver.beginThreadRun("other");
    saver.endThreadRun("other", "finished", finished, false);
    await saver.noteThreadStatus("other", "finished");
    expect(saver.storage["waiting"]).toBeDefined();
    expect(saver.storage["other"]).toBeUndefined();
  });

  it("a finish on the same thread does not clear another run's park", async () => {
    const saver = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ maxFinishedThreads: 0, finishedTtl: null }),
    );
    await saver.put(config("same"), checkpoint("1", { n: 1 }, { n: 1 }), meta(1));
    const parked = saver.beginThreadRun("same");
    saver.endThreadRun("same", "paused", parked);
    const sibling = saver.beginThreadRun("same");
    saver.endThreadRun("same", "finished", sibling, false);
    await saver.noteThreadStatus("same", "finished");
    expect(saver.storage["same"]).toBeDefined();
  });
});

function gateSpec(gates: number): GraphSpec {
  const nodes = Array.from({ length: gates }, (_, i) => ({
    id: `g${i}`,
    type: "hitl",
    with: { mode: "approve", message: `gate ${i}`, output: { to: `r${i}` } },
  }));
  const channels: Record<string, { type: "object" }> = {};
  for (let i = 0; i < gates; i++) channels[`r${i}`] = { type: "object" };
  const edges = [
    { from: "START", to: "g0" },
    ...Array.from({ length: gates - 1 }, (_, i) => ({ from: `g${i}`, to: `g${i + 1}` })),
    { from: `g${gates - 1}`, to: "END" },
  ];
  return {
    metadata: { name: `gates-${gates}` },
    state: { channels },
    nodes,
    edges,
  } as unknown as GraphSpec;
}

async function finishGates(compiled: Awaited<ReturnType<typeof compileGraph>>, threadId: string, gates: number) {
  let result = await compiled.run({ threadId, onInterrupt: "fail" });
  for (let i = 0; i < gates; i++) {
    expect(result.status).toBe("interrupted");
    result = await compiled.resume({ threadId, resume: { approved: true }, onInterrupt: "fail" });
  }
  expect(result.status).toBe("completed");
}

describe("several interrupts then a sweep", () => {
  for (const gates of [2, 3]) {
    it(`a ${gates}-gate thread is swept after it finishes`, async () => {
      const saver = new FlowgraphMemorySaver(
        resolveCheckpointRetention({ finishedTtl: "1h", maxFinishedThreads: null }),
      );
      const compiled = await compileGraph(gateSpec(gates), { checkpointer: saver });
      const threadId = `gates-${gates}`;
      await finishGates(compiled, threadId, gates);
      await saver.sweep(Date.now() + 2 * 60 * 60 * 1000);
      expect(saver.storage[threadId]).toBeUndefined();
    });
  }

  it("marks the thread active before a later run reads its checkpoint", async () => {
    const saver = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ finishedTtl: "1h", maxFinishedThreads: null }),
    );
    const spec = {
      metadata: { name: "read-window" },
      state: { channels: { n: { type: "number" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "retTag", output: { to: "n" } } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    const compiled = await compileGraph(spec, { checkpointer: saver });
    const threadId = "read-window";
    await compiled.run({ threadId, input: { n: 1 }, onInterrupt: "fail" });
    const seen: Array<string | undefined> = [];
    const orig = saver.getTuple.bind(saver);
    saver.getTuple = async (config) => {
      const row = (saver as unknown as { threads: Map<string, { status: string }> }).threads.get(threadId);
      seen.push(row?.status);
      await saver.sweep(Date.now() + 2 * 60 * 60 * 1000);
      return orig(config);
    };
    const again = await compiled.run({ threadId, input: { n: 2 }, onInterrupt: "fail" });
    expect(again.status).toBe("completed");
    expect(seen[0]).toBe("active");
    expect(saver.storage[threadId]).toBeDefined();
  });

  it("a read that throws before the run starts keeps the finished thread sweepable", async () => {
    const saver = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ finishedTtl: "1h", maxFinishedThreads: null }),
    );
    const spec = {
      metadata: { name: "read-throws" },
      state: { channels: { n: { type: "number" } } },
      nodes: [{ id: "a", type: "function", with: { fn: "retTag", output: { to: "n" } } }],
      edges: [
        { from: "START", to: "a" },
        { from: "a", to: "END" },
      ],
    } as unknown as GraphSpec;
    const compiled = await compileGraph(spec, { checkpointer: saver });
    const threadId = "read-throws";
    await compiled.run({ threadId, input: { n: 1 }, onInterrupt: "fail" });
    const realId = (await compiled.getState(threadId))?.checkpointId;
    expect(realId).toBeTruthy();
    const orig = saver.getTuple.bind(saver);
    let calls = 0;
    saver.getTuple = async (config) => {
      calls += 1;
      if (calls === 1) throw new Error("getState failed");
      return orig(config);
    };
    await expect(compiled.resume({ threadId, resume: true, onInterrupt: "fail" })).rejects.toThrow(/getState failed/);
    expect((saver as unknown as { threads: Map<string, { status: string }> }).threads.get(threadId)?.status).toBe("finished");
    saver.getTuple = orig;
    await saver.sweep(Date.now() + 2 * 60 * 60 * 1000);
    expect(saver.storage[threadId]).toBeUndefined();

    const again = new FlowgraphMemorySaver(
      resolveCheckpointRetention({ finishedTtl: "1h", maxFinishedThreads: null }),
    );
    const againCompiled = await compileGraph(spec, { checkpointer: again });
    const againThread = "tuple-throws";
    await againCompiled.run({ threadId: againThread, input: { n: 1 }, onInterrupt: "fail" });
    const keptId = (await againCompiled.getState(againThread))?.checkpointId;
    const origAgain = again.getTuple.bind(again);
    let lookups = 0;
    again.getTuple = async (config) => {
      lookups += 1;
      const id = (config as { configurable?: { checkpoint_id?: string } }).configurable?.checkpoint_id;
      if (lookups > 1 && id === keptId) throw new Error("tuple failed");
      return origAgain(config);
    };
    await expect(
      againCompiled.resumeFrom({ threadId: againThread, checkpointId: keptId!, resume: true, onInterrupt: "fail" }),
    ).rejects.toThrow(/tuple failed/);
    expect((again as unknown as { threads: Map<string, { status: string }> }).threads.get(againThread)?.status).toBe("finished");
    again.getTuple = origAgain;
    await again.sweep(Date.now() + 2 * 60 * 60 * 1000);
    expect(again.storage[againThread]).toBeUndefined();
  });
});
