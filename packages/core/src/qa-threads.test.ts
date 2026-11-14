import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";

function graph(gate = false): GraphSpec {
  return GraphSpecSchema.parse({ apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "thread-qa" }, nodes: [...(gate ? [{ id: "gate", type: "hitl", with: { mode: "approve", message: "approve" } }] : []), { id: "work", type: "function", with: { fn: "qaThreadWork" } }], edges: [{ from: "START", to: gate ? "gate" : "work" }, ...(gate ? [{ from: "gate", to: "work" }] : []), { from: "work", to: "END" }] });
}
function barrier() {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let effects = 0;
  registerFunction("qaThreadWork", async () => { effects++; entered(); await blocked; return "done"; });
  return { ready, release, effects: () => effects };
}
describe("PLAT-306: execution ownership", () => {
  it("excludes another graph instance using the same saver and thread", async () => {
    const hold = barrier(), saver = new MemorySaver();
    const first = await compileGraph(graph(), { checkpointer: saver });
    const second = await compileGraph(graph(), { checkpointer: saver });
    const running = first.run({ threadId: "same" });
    try { await hold.ready; await expect(second.run({ threadId: "same" })).rejects.toMatchObject({ code: "THREAD_BUSY" }); }
    finally { hold.release(); }
    expect((await running).status).toBe("completed");
    expect(hold.effects()).toBe(1);
  });
  it("prevents overlapping and completed resumes from repeating post-gate effects", async () => {
    const hold = barrier(), saver = new MemorySaver();
    const first = await compileGraph(graph(true), { checkpointer: saver });
    const second = await compileGraph(graph(true), { checkpointer: saver });
    expect((await first.run({ threadId: "resume" })).status).toBe("interrupted");
    const running = first.resume({ threadId: "resume", resume: true });
    try { await hold.ready; await expect(second.resume({ threadId: "resume", resume: true })).rejects.toMatchObject({ code: "THREAD_BUSY" }); }
    finally { hold.release(); }
    expect((await running).status).toBe("completed");
    await expect(second.resume({ threadId: "resume", resume: true })).rejects.toMatchObject({ code: "THREAD_NOT_WAITING" });
    expect(hold.effects()).toBe(1);
  });
  it("rejects a competing stream without sending a terminal event to the active owner", async () => {
    const hold = barrier();
    const g = await compileGraph(graph());
    const terminal: string[] = [];
    g.events.subscribe(e => { if (["run.end", "run.error"].includes(e.type)) terminal.push(e.type); });
    const running = g.run({ threadId: "stream" });
    try { await hold.ready; await expect(g.stream({ threadId: "stream" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "THREAD_BUSY" }); }
    finally { hold.release(); }
    expect((await running).status).toBe("completed");
    expect(terminal).toEqual(["run.end"]);
  });
  it("runs independent threads concurrently and isolates their streams", async () => {
    const hold = barrier();
    const g = await compileGraph(graph());
    const seen: Record<string, string[]> = { a: [], b: [] };
    const collect = async (id: string) => {
      for await (const event of g.stream({ threadId: id })) {
        expect(event.threadId).toBe(id);
        seen[id]!.push(event.type);
      }
    };
    const a = collect("a");
    await hold.ready;
    const b = collect("b");
    try {
      // Both must enter the function while the first is still held.
      for (let i = 0; i < 100 && hold.effects() < 2; i++) await new Promise(r => setTimeout(r, 1));
      expect(hold.effects()).toBe(2);
    } finally { hold.release(); }
    await Promise.all([a, b]);
    expect(seen.a!.filter(x => x === "run.end")).toHaveLength(1);
    expect(seen.b!.filter(x => x === "run.end")).toHaveLength(1);
    // A later stream must not replay either of the earlier terminal events.
    const later = [];
    for await (const event of g.stream({ threadId: "c" })) later.push(event);
    expect(later.every(event => event.threadId === "c")).toBe(true);
    expect(later.filter(event => event.type === "run.end")).toHaveLength(1);
  });
});
describe("PLAT-307: unknown threads", () => {
  it.each(["resume", "continue", "step"])("refuses %s before creating any checkpoint", async method => {
    const saver = new MemorySaver(), g = await compileGraph(graph(), { checkpointer: saver });
    const result = method === "resume" ? g.resume({ threadId: "unknown", resume: true }) : method === "step" ? g.step({ threadId: "unknown" }) : g.continueRun({ threadId: "unknown" });
    await expect(result).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    expect(await saver.getTuple({ configurable: { thread_id: "unknown" } })).toBeUndefined();
  });
});


it("reserves one prepared invocation without starting work and prevents claim reuse", async () => {
  let effects = 0; registerFunction("qaThreadWork", () => { effects++; return "done"; });
  const g = await compileGraph(graph());
  const prepared = await g.prepare({ mode: "start", options: { threadId: "reserved" } });
  expect(effects).toBe(0);
  await expect(g.run({ threadId: "reserved" })).rejects.toMatchObject({ code: "THREAD_BUSY" });
  expect((await prepared.execute()).status).toBe("completed");
  await expect(prepared.execute()).rejects.toMatchObject({ code: "THREAD_CLAIM_INVALID" });
  expect(effects).toBe(1);
});

it("does not accept or release a supplied claim for another saver or thread", async () => {
  const { acquireThreadRun, inspectThreadRun } = await import("./checkpoint/execution-claim.js");
  const saver = new MemorySaver(), g = await compileGraph(graph(), { checkpointer: saver });
  const claim = await acquireThreadRun(saver, "a");
  await expect(g.prepare({ mode: "start", options: { threadId: "b" } }, claim)).rejects.toMatchObject({ code: "THREAD_CLAIM_INVALID" });
  expect(await inspectThreadRun(saver, "a")).toBeDefined();
  await claim.release();
  expect(await inspectThreadRun(saver, "a")).toBeUndefined();
});


it("can inspect an overdue wait while another owner holds admission", async () => {
  const { acquireThreadRun } = await import("./checkpoint/execution-claim.js");
  let now = Date.now(); const saver = new MemorySaver();
  const s = GraphSpecSchema.parse({ apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "busy-inspection" }, nodes: [{ id: "wait", type: "wait", with: { signal: "ready", timeout: "1s" } }], edges: [{ from: "START", to: "wait" }, { from: "wait", to: "END" }] });
  const g = await compileGraph(s, { checkpointer: saver, now: () => now, scheduleTimeout: () => ({ unref() {} }) });
  await g.run({ threadId: "inspection" });
  const claim = await acquireThreadRun(saver, "inspection"); now += 2000;
  try { expect((await g.getState("inspection"))?.interrupts).toHaveLength(1); }
  finally { await claim.release(); }
});
