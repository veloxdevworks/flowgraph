import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { loadGraph, compileForTest, eventsOfType } from "@veloxdevworks/flowgraph-testing";
import "./register.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const graphPath = path.join(__dirname, "review-loop.graph.yaml");

async function compiled() {
  const { spec } = await loadGraph(graphPath, { cwd: __dirname });
  if (!spec) throw new Error("failed to load review-loop graph");
  return compileForTest(spec);
}

describe("review-loop example", () => {
  it("interrupts at review", async () => {
    const { compiled: graph } = await compiled();
    const result = await graph.run({
      threadId: "rl-1",
      input: { topic: "Launch post" },
      onInterrupt: "fail",
    });

    expect(result.status).toBe("interrupted");
    expect(result.interrupts?.[0]?.reason).toContain("Approve this draft");
    expect(result.state["final"]).toBeFalsy();
  });

  it("loops on rejection then completes on approval", async () => {
    const { compiled: graph, events } = await compiled();

    const first = await graph.run({
      threadId: "rl-2",
      input: { topic: "Loop test" },
      onInterrupt: "fail",
    });
    expect(first.status).toBe("interrupted");

    const rejected = await graph.resume({
      threadId: "rl-2",
      resume: { approved: false },
    });
    expect(rejected.status).toBe("interrupted");
    expect(String(rejected.state["draft"])).toContain("Revised");
    expect(rejected.state["revision"]).toBe(1);

    const approved = await graph.resume({
      threadId: "rl-2",
      resume: { approved: true },
    });
    expect(approved.status).toBe("completed");
    expect(String(approved.state["final"])).toContain("FINAL:");
    expect(eventsOfType(events, "interrupt.raised").length).toBeGreaterThanOrEqual(2);
  });

  it("completes immediately when approved on first resume", async () => {
    const { compiled: graph } = await compiled();
    await graph.run({ threadId: "rl-3", onInterrupt: "fail" });
    const done = await graph.resume({ threadId: "rl-3", resume: { approved: true } });
    expect(done.status).toBe("completed");
    expect(done.state["final"]).toBeTruthy();
  });
});
