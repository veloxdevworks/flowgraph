import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@flowgraph/spec";

beforeAll(() => {
  registerFunction("setA", () => "from-a");
  registerFunction("setB", () => "from-b");
});

function breakpointSpec(breakpoints: { before?: string[]; after?: string[] }): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "breakpoint-graph" },
    state: { channels: { a: { type: "string" }, b: { type: "string" } } },
    nodes: [
      { id: "nodeA", type: "function", with: { fn: "setA", output: { to: "a" } } },
      { id: "nodeB", type: "function", with: { fn: "setB", output: { to: "b" } } },
    ],
    edges: [
      { from: "START", to: "nodeA" },
      { from: "nodeA", to: "nodeB" },
      { from: "nodeB", to: "END" },
    ],
    runtime: {
      checkpoint: { enabled: true, backend: "memory" },
      hitl: { breakpoints },
    },
  } as unknown as GraphSpec;
}

describe("static breakpoints", () => {
  it("interruptBefore pauses with a synthetic breakpoint interrupt", async () => {
    const compiled = await compileGraph(breakpointSpec({ before: ["nodeB"] }), {});
    const r1 = await compiled.run({ threadId: "bp-before", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.id).toBe("breakpoint:nodeB");
    expect(r1.interrupts?.[0]?.reason).toContain("nodeB");
    expect(r1.state["a"]).toBe("from-a");
    expect(r1.state["b"] == null).toBe(true);

    const snap = await compiled.getState("bp-before");
    expect(snap?.next).toEqual(["nodeB"]);
    expect(snap?.interrupts[0]?.id).toBe("breakpoint:nodeB");

    const r2 = await compiled.resume({
      threadId: "bp-before",
      resume: { approved: true },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect(r2.state["a"]).toBe("from-a");
    expect(r2.state["b"]).toBe("from-b");
  });

  it("interruptAfter pauses after the named node", async () => {
    const compiled = await compileGraph(breakpointSpec({ after: ["nodeA"] }), {});
    const r1 = await compiled.run({ threadId: "bp-after", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.state["a"]).toBe("from-a");
    expect(r1.state["b"] == null).toBe(true);

    const r2 = await compiled.resume({
      threadId: "bp-after",
      resume: { approved: true },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect(r2.state["b"]).toBe("from-b");
  });

  it("compile-option interruptBefore is equivalent to spec breakpoints", async () => {
    const spec = breakpointSpec({});
    delete (spec.runtime as { hitl?: unknown }).hitl;
    const compiled = await compileGraph(spec, { interruptBefore: ["nodeB"] });
    const r1 = await compiled.run({ threadId: "bp-opt", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.id).toBe("breakpoint:nodeB");

    const r2 = await compiled.resume({ threadId: "bp-opt", resume: true, onInterrupt: "fail" });
    expect(r2.status).toBe("completed");
  });
});
