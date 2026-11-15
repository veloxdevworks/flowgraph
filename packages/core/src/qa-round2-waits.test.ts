import { describe, expect, it } from "vitest";
import { GraphSpecSchema } from "@flowgraph/spec";
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
