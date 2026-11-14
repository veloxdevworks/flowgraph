import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { createScriptedProvider } from "./providers/index.js";
import { closeWebhookServers } from "./runtime/webhook-server.js";
import type { FlowgraphEvent } from "./events.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeWebhookServers();
});
function graph(nodes: unknown[], edges: unknown[], runtime = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "gate-qa" },
    state: { channels: { answer: { type: "object" } } },
    nodes,
    edges,
    runtime: { webhookServer: { port: 0 }, ...runtime },
  });
}
const approve = () =>
  graph(
    [
      {
        id: "gate",
        type: "hitl",
        with: { mode: "approve", message: "approve", output: { to: "answer" } },
      },
    ],
    [
      { from: "START", to: "gate" },
      { from: "gate", to: "END" },
    ],
  );

describe("PLAT-310/349: gate decisions and events", () => {
  it("does not let continue or step supply an approval implicitly", async () => {
    const g = await compileGraph(approve());
    await g.run({ threadId: "continue-gate" });
    await expect(g.continueRun({ threadId: "continue-gate" })).rejects.toMatchObject({
      code: "RESUME_VALUE_REQUIRED",
    });
    await expect(g.step({ threadId: "continue-gate" })).rejects.toMatchObject({
      code: "RESUME_VALUE_REQUIRED",
    });
    expect((await g.getState("continue-gate"))?.interrupts).toHaveLength(1);
  });
  it("emits one canonical interrupt event for a gate raise", async () => {
    const events: FlowgraphEvent[] = [];
    const g = await compileGraph(approve(), {
      sinks: [
        (e) => {
          events.push(e);
        },
      ],
    });
    expect((await g.run({ threadId: "event" })).status).toBe("interrupted");
    const raises = events.filter((e) => e.type === "interrupt.raised");
    expect(raises).toHaveLength(1);
    expect((raises[0]!.data as { interrupts: unknown[] }).interrupts).toHaveLength(1);
    expect((await g.resume({ threadId: "event", resume: true })).status).toBe("completed");
    expect(events.filter((e) => e.type === "interrupt.raised")).toHaveLength(1);
  });
  it("rejects replacing an answer already written at a historical checkpoint", async () => {
    const g = await compileGraph(approve());
    await g.run({ threadId: "historical" });
    const checkpointId = (await g.getState("historical"))!.checkpointId!;
    expect((await g.resume({ threadId: "historical", resume: true })).status).toBe("completed");
    await expect(
      g.resumeFrom({ threadId: "historical", checkpointId, resume: false }),
    ).rejects.toMatchObject({ code: "HISTORICAL_DECISION_REPLAY" });
  });
});

describe("PLAT-319: independent gate deadlines", () => {
  it("starts a fresh deadline when a completed gate is entered in a new loop round", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const spec = graph(
      [
        { id: "gate", type: "wait", with: { signal: "ready", timeout: "60s" } },
        {
          id: "route",
          type: "router",
          with: {
            routes: {
              again: { when: "{{ state.outputs.gate.round < 2 }}", to: "gate" },
              done: { default: true, to: "END" },
            },
          },
        },
      ],
      [
        { from: "START", to: "gate" },
        { from: "gate", to: "route" },
      ],
    );
    const g = await compileGraph(spec, { now: () => now, scheduleTimeout: () => ({ unref() {} }) });
    const first = await g.run({ threadId: "round" });
    now += 20_000;
    const next = await g.resume({ threadId: "round", resume: { round: 1 } });
    expect(next.status).toBe("interrupted");
    expect(
      Date.parse(next.interrupts![0]!.deadlineAt!) - Date.parse(first.interrupts![0]!.deadlineAt!),
    ).toBe(20_000);
    expect((await g.resume({ threadId: "round", resume: { round: 2 } })).status).toBe("completed");
  });
  it.each([false, true])(
    "preserves a sibling deadline across resume (recompile=%s)",
    async (recompile) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const events: FlowgraphEvent[] = [];
      const saver = new MemorySaver();
      const spec = graph(
        ["left", "right"].map((id) => ({
          id,
          type: "wait",
          with: { webhook: true, timeout: "60s" },
        })),
        [
          { from: "START", to: ["left", "right"] },
          { from: "left", to: "END" },
          { from: "right", to: "END" },
        ],
      );
      const options = {
        checkpointer: saver,
        now: () => now,
        scheduleTimeout: () => ({ unref() {} }),
        sinks: [
          (e: FlowgraphEvent) => {
            events.push(e);
          },
        ],
      };
      let g = await compileGraph(spec, options);
      const first = await g.run({ threadId: "deadlines" });
      expect(first.interrupts).toHaveLength(2);
      const left = first.interrupts!.find(
        (i) => (i.payload as { data: { __nodeId: string } }).data.__nodeId === "left",
      )!;
      const right = first.interrupts!.find((i) => i.id !== left.id)!;
      now += 20_000;
      if (recompile) g = await compileGraph(spec, options);
      const next = await g.resume({ threadId: "deadlines", resume: { [left.id!]: { ok: true } } });
      expect(next.status).toBe("interrupted");
      expect(next.interrupts).toHaveLength(1);
      expect(next.interrupts![0]!.deadlineAt).toBe(right.deadlineAt);
      expect(events.filter((e) => e.type === "interrupt.raised")).toHaveLength(2);
    },
  );
});

describe("PLAT-329: ask_human choices", () => {
  async function compiled() {
    const provider = createScriptedProvider("qa-human", async (_req, ctx) => ({
      output: await ctx.invokeTool("ask_human", { question: "color?", choices: ["red", "blue"] }),
      stopReason: "done",
    }));
    return compileGraph(
      graph(
        [
          {
            id: "ask",
            type: "agent",
            provider: provider.name,
            with: { prompt: "ask", tools: [{ function: "ask_human" }], output: { to: "answer" } },
          },
        ],
        [
          { from: "START", to: "ask" },
          { from: "ask", to: "END" },
        ],
      ),
      { providers: [provider] },
    );
  }
  it("rejects invalid choices with a new prompt and can accept a later valid choice", async () => {
    const g = await compiled();
    await g.run({ threadId: "choice" });
    const invalid = await g.resume({ threadId: "choice", resume: "purple" });
    expect(invalid.status).toBe("interrupted");
    expect(JSON.stringify(invalid.interrupts)).toContain("validationError");
    const result = await g.resume({ threadId: "choice", resume: "blue" });
    expect(result.status).toBe("completed");
    expect(result.state.answer).toEqual({ answer: "blue" });
  });
  it("maps a one-based numeric index to its choice", async () => {
    const g = await compiled();
    await g.run({ threadId: "index" });
    const result = await g.resume({ threadId: "index", resume: 2 });
    expect(result.status).toBe("completed");
    expect(result.state.answer).toEqual({ answer: "blue" });
  });
});
