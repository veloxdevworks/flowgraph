import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSpecSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { createScriptedProvider } from "./providers/index.js";
import { readRunIssues } from "./runtime/run-issues.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function workspace() { const dir = await mkdtemp(join(tmpdir(), "fg-round3-map-")); dirs.push(dir); return dir; }
function graph(node: unknown, runtime = {}, concurrency = 1) {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "map-control" },
    state: { channels: { items: { type: "array", default: [] }, results: { type: "array", reducer: "append", default: [] } } },
    nodes: [{ id: "fan", type: "map", with: { over: "{{ state.items }}", as: "row", concurrency, node, collect: { to: "results" } } }],
    edges: [{ from: "START", to: "fan" }, { from: "fan", to: "END" }], runtime,
  });
}

describe("PLAT-388 / PLAT-396 / PLAT-397 map controls", () => {
  it.each(["continue", "ignore"])("persists ordinary %s failures through the same issue journal as map items", async policy => {
    registerFunction("round3OrdinaryFailure", () => { throw new Error("bad row"); });
    const spec = graph({ type: "function", with: { fn: "round3OrdinaryFailure" } });
    spec.nodes = [{ id: "bad", type: "function", on: { error: policy }, with: { fn: "round3OrdinaryFailure" } }] as typeof spec.nodes;
    spec.edges = [{ from: "START", to: "bad" }, { from: "bad", to: "END" }];
    const cwd = await workspace();
    const result = await (await compileGraph(spec, { cwd })).run({ threadId: `ordinary-${policy}` });
    expect(result.status).toBe("completed");
    expect(result.issues).toHaveLength(1);
    expect(readRunIssues(cwd, `ordinary-${policy}`)).toContainEqual(expect.objectContaining({ code: "ERROR_SWALLOWED", nodeId: "bad" }));
  });

  it.each(["single", "keyed"])("shows one budget gate, allows one more call, and preserves finished items on %s decline", async mode => {
    let calls = 0;
    const provider = createScriptedProvider("round3-map", () => ({ output: `paid-${++calls}`, stopReason: "done", usage: { totalTokens: 100 } }));
    const spec = graph({ type: "agent", provider: "round3-map", with: { prompt: "short idea" } }, { budget: { maxTokens: 250, onExceed: "interrupt" } });
    const g = await compileGraph(spec, { cwd: await workspace(), providers: [provider] });
    const threadId = `budget-${mode}`;
    const first = await g.run({ threadId, input: { items: [1, 2, 3, 4, 5, 6], results: ["seed"] } });
    expect(first).toMatchObject({ status: "interrupted", state: { results: ["seed", "paid-1", "paid-2", "paid-3"] } });
    expect(first.interrupts).toHaveLength(1);
    expect(first.interrupts![0]!.reason).toContain("usd=unknown");
    expect(calls).toBe(3);
    expect((await g.getState(threadId))?.values.results).toEqual(first.state.results);
    expect((await g.getState(threadId))?.interrupts).toHaveLength(1);
    const approved = await g.resume({ threadId, resume: { approved: true } });
    expect(approved.status).toBe("interrupted");
    expect(approved.interrupts).toHaveLength(1);
    expect(calls).toBe(4);
    expect(approved.state.results).toEqual(["seed", "paid-1", "paid-2", "paid-3", "paid-4"]);
    const resume = mode === "single" ? { approved: false } : { [approved.interrupts![0]!.id]: { approved: false } };
    const declined = await g.resume({ threadId, resume });
    expect(declined).toMatchObject({ status: "error", error: { code: "BUDGET_DENIED" }, state: { results: approved.state.results } });
    expect(calls).toBe(4);
  });

  it("parks queued items after admitted work and continues without duplicating append collects", async () => {
    const seen: number[] = [];
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    registerFunction("round3PauseMap", async input => {
      const row = (input as { row: number }).row;
      seen.push(row);
      if (seen.length === 3) entered();
      if (row < 3) await held;
      return row;
    });
    const g = await compileGraph(graph({ type: "function", with: { fn: "round3PauseMap", input: { row: "{{ item.row }}" } } }, {}, 3), { cwd: await workspace() });
    const pause = new AbortController();
    const running = g.run({ threadId: "paused-map", input: { items: Array.from({ length: 12 }, (_, i) => i), results: ["seed"] }, pauseSignal: pause.signal });
    await ready;
    pause.abort();
    release();
    const parked = await running;
    expect(parked.status).toBe("paused");
    expect(seen).toEqual([0, 1, 2]);
    expect(parked.state.results).toEqual(["seed", 0, 1, 2]);
    expect((await g.getState("paused-map"))?.values.results).toEqual(parked.state.results);
    const finished = await g.continueRun({ threadId: "paused-map" });
    expect(finished.status).toBe("completed");
    expect(finished.state.results).toEqual(["seed", ...Array.from({ length: 12 }, (_, i) => i)]);
    expect(seen).toHaveLength(12);
  });

  it("persists swallowed item failures in the issue journal while collecting successful siblings", async () => {
    registerFunction("round3SwallowMap", input => {
      const row = (input as { row: number }).row;
      if (row < 0) throw new Error(`bad row ${row}`);
      return row;
    });
    const cwd = await workspace();
    const g = await compileGraph(graph({ type: "function", on: { error: "continue" }, with: { fn: "round3SwallowMap", input: { row: "{{ item.row }}" } } }, {}, 2), { cwd });
    const result = await g.run({ threadId: "swallowed-map", input: { items: [1, -2, 3, -4] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([1, 3]);
    expect(result.issues?.map(issue => issue.code)).toEqual(["ERROR_SWALLOWED", "ERROR_SWALLOWED"]);
    const issues = readRunIssues(cwd, "swallowed-map");
    expect(issues).toHaveLength(2);
    expect(issues.map(issue => issue.nodeId).sort()).toEqual(["fan[1]", "fan[3]"]);
    expect(issues.every(issue => issue.impact?.includes("Failed items have no collected value"))).toBe(true);
  });
});
