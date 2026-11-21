import { describe, expect, it } from "vitest";
import { GraphSpecSchema } from "@flowgraph/spec";
import { MemorySaver } from "@langchain/langgraph";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph } from "./compiler.js";
const gate = (type: string, withConfig: unknown) =>
  GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "round2-waits" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [{ id: "gate", type, with: withConfig }],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "END" },
    ],
  });
describe("PLAT-371/375: wait and auto-approval outcomes", () => {
  it("completes an expired conditional wait rather than raising it forever", async () => {
    const graph = await compileGraph(
      gate("wait", { until: "{{ false }}", timeout: "1ms", output: { to: "answer" } }),
      { now: () => Date.now() + 60000, scheduleTimeout: () => ({ unref() {} }) },
    );
    expect((await graph.run({ threadId: "until" })).status).toBe("interrupted");
    const result = await graph.resume({ threadId: "until", resume: true });
    expect(result.status).toBe("completed");
    expect(result.state.answer).toEqual({ timedOut: true });
  });
  it("auto-approves review gates with their accepted decision payload", async () => {
    const graph = await compileGraph(
      gate("hitl", {
        mode: "review",
        message: "Review",
        diff: { before: "a", after: "b" },
        output: { to: "answer" },
      }),
    );
    const result = await graph.run({ onInterrupt: "approve" });
    expect(result.status).toBe("completed");
    expect(result.state.answer).toMatchObject({ decision: "approve" });
  });
  it("resumes an already-expired wait without inventing a human answer", async () => {
    const graph = await compileGraph(gate("wait", { signal: "ready", timeout: "1ms" }), {
      now: () => Date.now() + 60000,
      scheduleTimeout: () => ({ unref() {} }),
    });
    await graph.run({ threadId: "expired" });
    expect((await graph.resume({ threadId: "expired", resume: undefined })).status).toBe(
      "completed",
    );
  });
  it("refuses auto-approval of a form before consuming invalid answer attempts", async () => {
    const graph = await compileGraph(
      gate("hitl", {
        mode: "form",
        message: "Input",
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      }),
    );
    const result = await graph.run({ onInterrupt: "approve" });
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "AUTO_APPROVE_UNSUPPORTED" });
  });
});

it("clamps long wait timers without changing the stored deadline", async () => {
  let delay = 0;
  const graph = await compileGraph(gate("wait", { signal: "ready", timeout: "30d" }), {
    scheduleTimeout: (_fn, ms) => {
      delay = ms;
      return { unref() {} };
    },
  });
  const result = await graph.run({ threadId: "long" });
  expect(delay).toBe(2 ** 31 - 1);
  expect(Date.parse(result.interrupts![0]!.deadlineAt!)).toBeGreaterThan(
    Date.now() + 29 * 86400000,
  );
});
it("publishes the completed state when a deadline finds another process already resumed the thread", async () => {
  const checkpointer = new MemorySaver();
  let fire = () => {};
  let now = Date.now();
  let done!: (result: { status: string }) => void;
  const observed = new Promise<{ status: string }>((resolve) => {
    done = resolve;
  });
  const spec = gate("wait", { signal: "ready", timeout: "1s" });
  const original = await compileGraph(spec, {
    checkpointer,
    now: () => now,
    scheduleTimeout: (fn) => {
      fire = fn;
      return { unref() {} };
    },
    onWaitTimeout: done,
  });
  await original.run({ threadId: "external" });
  const second = await compileGraph(spec, { checkpointer });
  expect((await second.resume({ threadId: "external", resume: "ready" })).status).toBe("completed");
  now += 5000;
  fire();
  expect((await observed).status).toBe("completed");
});
it("refuses review auto-approval when an artifact selection is required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-review-pick-"));
  try {
    await writeFile(join(dir, "a.txt"), "a");
    await writeFile(join(dir, "b.txt"), "b");
    const graph = await compileGraph(
      gate("hitl", {
        mode: "review",
        message: "Choose",
        diff: { before: "a", after: "b" },
        select: "one",
        artifacts: ["a.txt", "b.txt"],
      }),
      { cwd: dir },
    );
    const result = await graph.run({ threadId: "selection", onInterrupt: "approve" });
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "AUTO_APPROVE_UNSUPPORTED" });
    expect(
      (await graph.getState("selection", { applyWaitTimeouts: false }))?.interrupts[0]
        ?.validationError,
    ).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
