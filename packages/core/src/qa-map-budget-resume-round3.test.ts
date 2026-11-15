import { expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { GraphSpecSchema } from "@flowgraph/spec";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph } from "./compiler.js";
import { createScriptedProvider } from "./providers/index.js";

function spec() {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "budget-resume-round3" },
    state: { channels: { rows: { type: "array", default: [1, 2, 3, 4, 5, 6] }, collected: { type: "array", reducer: "append", default: ["seed"] } } },
    nodes: [{ id: "fan", type: "map", with: {
      over: "{{ state.rows }}", as: "row", concurrency: 3,
      node: { type: "agent", provider: "budget-resume", with: { prompt: "short idea" } },
      collect: { to: "collected" },
    } }],
    edges: [{ from: "START", to: "fan" }, { from: "fan", to: "END" }],
    runtime: { budget: { maxTokens: 250, onExceed: "interrupt" } },
  });
}

it("keeps pending map collection and budget usage across recompilation before approval and denial", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fg-budget-recompile-"));
  try {
    let calls = 0;
    const provider = createScriptedProvider("budget-resume", () => ({ output: `paid-${++calls}`, usage: { totalTokens: 100 }, stopReason: "done" }));
    const checkpointer = new MemorySaver();
    const compile = () => compileGraph(spec(), { cwd, checkpointer, providers: [provider] });
    const first = await (await compile()).run({ threadId: "recompiled" });
    expect(first).toMatchObject({ status: "interrupted", state: { collected: ["seed", "paid-1", "paid-2", "paid-3"] }, usage: { calls: 3, totalTokens: 300 } });
    const secondGraph = await compile();
    expect((await secondGraph.getState("recompiled"))?.values.collected).toEqual(first.state.collected);
    const second = await secondGraph.resume({ threadId: "recompiled", resume: { [first.interrupts![0]!.id]: { approved: true } } });
    expect(second).toMatchObject({ status: "interrupted", state: { collected: ["seed", "paid-1", "paid-2", "paid-3", "paid-4"] }, usage: { calls: 4, totalTokens: 400 } });
    const thirdGraph = await compile();
    const third = await thirdGraph.resume({ threadId: "recompiled", resume: { approved: false } });
    expect(third).toMatchObject({ status: "error", error: { code: "BUDGET_DENIED" }, state: { collected: second.state.collected }, usage: { calls: 4, totalTokens: 400 } });
    expect(calls).toBe(4);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("applies a single inline budget rejection to every queued budget wait", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fg-budget-inline-"));
  try {
    let calls = 0, decisions = 0;
    const provider = createScriptedProvider("budget-resume", () => ({ output: `paid-${++calls}`, usage: { totalTokens: 100 }, stopReason: "done" }));
    const graph = await compileGraph(spec(), { cwd, providers: [provider] });
    const result = await graph.run({ threadId: "inline", onInterrupt: "prompt", resolveInterrupt(interrupts) {
      decisions++;
      expect(interrupts).toHaveLength(1);
      return { approved: false };
    } });
    expect(result).toMatchObject({ status: "error", error: { code: "BUDGET_DENIED" }, state: { collected: ["seed", "paid-1", "paid-2", "paid-3"] } });
    expect(calls).toBe(3);
    expect(decisions).toBe(1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
