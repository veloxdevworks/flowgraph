import { describe, it, expect } from "vitest";
import { compileGraph } from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";

/** The default `flowgraph resume --resume '{"approved":true}'` body. */
const CLI_UNKEYED_RESUME = { approved: true };

const PARALLEL = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "parallel-gates" },
  state: {
    channels: {
      gateA: { type: "object" },
      gateB: { type: "object" },
    },
  },
  nodes: [
    { id: "gate-a", type: "hitl", with: { mode: "approve", message: "A?", output: { to: "gateA" } } },
    { id: "gate-b", type: "hitl", with: { mode: "question", message: "B?", output: { to: "gateB" } } },
  ],
  edges: [
    { from: "START", to: ["gate-a", "gate-b"] },
    { from: "gate-a", to: "END" },
    { from: "gate-b", to: "END" },
  ],
  runtime: {
    checkpoint: { enabled: true, backend: "memory" },
    hitl: { onInterrupt: "fail" },
  },
} as unknown as GraphSpec;

describe("flowgraph resume with several pending interrupts", () => {
  it("refuses an unkeyed --resume value and leaves both gates pending", async () => {
    const compiled = await compileGraph(PARALLEL, {});
    const first = await compiled.run({ threadId: "t1", onInterrupt: "fail" });
    expect(first.status).toBe("interrupted");
    expect(first.interrupts).toHaveLength(2);

    await expect(
      compiled.resume({ threadId: "t1", resume: CLI_UNKEYED_RESUME, onInterrupt: "fail" }),
    ).rejects.toMatchObject({ code: "RESUME_MAP_REQUIRED" });

    const snap = await compiled.getState("t1");
    expect(snap?.interrupts).toHaveLength(2);
  });
});
