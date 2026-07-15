import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { FlowgraphEvent } from "./events.js";

beforeAll(() => {
  registerFunction("stepA", async () => {
    await new Promise((r) => setTimeout(r, 30));
    return "a";
  });
  registerFunction("stepB", async () => {
    await new Promise((r) => setTimeout(r, 30));
    return "b";
  });
  registerFunction("stepC", async () => {
    await new Promise((r) => setTimeout(r, 30));
    return "c";
  });
});

function threeStepSpec(): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "pause-continue" },
    state: {
      channels: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
    },
    nodes: [
      { id: "n1", type: "function", with: { fn: "stepA", output: { to: "a" } } },
      { id: "n2", type: "function", with: { fn: "stepB", output: { to: "b" } } },
      { id: "n3", type: "function", with: { fn: "stepC", output: { to: "c" } } },
    ],
    edges: [
      { from: "START", to: "n1" },
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("pause / continueRun", () => {
  it("pauses after the in-flight node and continues the rest without re-running completed nodes", async () => {
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(threeStepSpec(), {
      sinks: [(ev) => events.push(ev)],
    });

    const pause = new AbortController();
    const threadId = "pause-t1";

    // Abort pause after the first node completes.
    const unsub = compiled.events.subscribe((ev) => {
      if (ev.type === "node.end" && ev.scope.nodeId === "n1") {
        pause.abort();
      }
    });

    const paused = await compiled.run({
      threadId,
      pauseSignal: pause.signal,
      onInterrupt: "fail",
    });
    unsub();

    expect(paused.status).toBe("paused");
    expect(paused.state["a"]).toBe("a");
    expect(paused.state["b"] == null).toBe(true);
    expect(paused.state["c"] == null).toBe(true);
    expect(events.some((e) => e.type === "run.paused")).toBe(true);

    const endsBeforeContinue = events.filter((e) => e.type === "node.end").map((e) => e.scope.nodeId);
    expect(endsBeforeContinue).toEqual(["n1"]);

    const continued = await compiled.continueRun({
      threadId,
      onInterrupt: "fail",
    });

    expect(continued.status).toBe("completed");
    expect(continued.state["a"]).toBe("a");
    expect(continued.state["b"]).toBe("b");
    expect(continued.state["c"]).toBe("c");
    expect(events.some((e) => e.type === "run.continued")).toBe(true);

    const allEnds = events.filter((e) => e.type === "node.end").map((e) => e.scope.nodeId);
    expect(allEnds).toEqual(["n1", "n2", "n3"]);
  });

  it("runs to completion when pauseSignal is never aborted", async () => {
    const pause = new AbortController();
    const compiled = await compileGraph(threeStepSpec());
    const result = await compiled.run({
      threadId: "pause-t2",
      pauseSignal: pause.signal,
      onInterrupt: "fail",
    });
    expect(result.status).toBe("completed");
    expect(result.state["a"]).toBe("a");
    expect(result.state["b"]).toBe("b");
    expect(result.state["c"]).toBe("c");
  });
});
