import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
import { registerFunction } from "./nodes/code.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { FlowgraphEvent } from "./events.js";

beforeAll(() => {
  registerFunction("emitA", () => "a");
  registerFunction("emitB", () => "b");
});

function fanOutSpec(channel: { type: string; reducer?: string }): GraphSpec {
  return {
    metadata: { name: "fan-in-warning-test" },
    state: {
      channels: {
        result: channel,
      },
    },
    nodes: [
      {
        id: "branch-a",
        type: "code",
        with: { fn: "emitA", output: { to: "result" } },
      },
      {
        id: "branch-b",
        type: "code",
        with: { fn: "emitB", output: { to: "result" } },
      },
    ],
    edges: [
      { from: "START", to: ["branch-a", "branch-b"] },
      { from: "branch-a", to: "END" },
      { from: "branch-b", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("fan-in lastWrite warning", () => {
  it("validateSpec reports warning for parallel lastWrite fan-in", () => {
    const diags = validateSpec(fanOutSpec({ type: "string" }));
    expect(diags.some((d) => d.code === "FANIN_LAST_WRITE" && d.severity === "warning")).toBe(true);
  });

  it("validateSpec does not warn when the shared channel uses append", () => {
    const diags = validateSpec(fanOutSpec({ type: "array", reducer: "append" }));
    expect(diags.some((d) => d.code === "FANIN_LAST_WRITE")).toBe(false);
  });

  it("compileGraph logs warning for parallel lastWrite fan-in", async () => {
    const logs: FlowgraphEvent[] = [];
    await compileGraph(fanOutSpec({ type: "string" }), {
      sinks: [(ev) => { logs.push(ev); }],
    });

    const warns = logs.filter((e) => e.type === "log" && (e.data as { level?: string }).level === "warn");
    expect(warns.some((w) => String((w.data as { msg?: string }).msg).includes('channel "result"'))).toBe(true);
  });
});
