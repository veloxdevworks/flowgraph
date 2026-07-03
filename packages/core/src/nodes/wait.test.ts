import { describe, it, expect } from "vitest";
import { compileGraph } from "../compiler.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { FlowgraphEvent } from "../events.js";

function waitGraph(withConfig: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "wait-graph" },
    state: { channels: { ready: { type: "boolean", default: false } } },
    nodes: [
      {
        id: "gate",
        type: "wait",
        with: withConfig,
      },
    ],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

function interruptData(interrupts: { payload?: unknown }[] | undefined): Record<string, unknown> {
  const payload = interrupts?.[0]?.payload as { data?: Record<string, unknown> } | undefined;
  return payload?.data ?? {};
}

describe("wait node", () => {
  it("duration mode emits node.output with durationMs and wakeAt before sleeping", async () => {
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(waitGraph({ duration: "50ms" }), {
      sinks: [(e) => { events.push(e); }],
    });

    const before = Date.now();
    const result = await compiled.run({ threadId: "wait-duration" });
    const after = Date.now();

    expect(result.status).toBe("completed");

    const output = events.find((e) => e.type === "node.output");
    expect(output?.scope.nodeId).toBe("gate");
    const wait = (output?.data as { wait: { mode: string; durationMs: number; wakeAt: string } }).wait;
    expect(wait.mode).toBe("duration");
    expect(wait.durationMs).toBe(50);

    const wakeAtMs = Date.parse(wait.wakeAt);
    expect(Number.isNaN(wakeAtMs)).toBe(false);
    expect(wakeAtMs).toBeGreaterThanOrEqual(before + 50);
    expect(wakeAtMs).toBeLessThanOrEqual(after + 50);
  });

  it("until mode includes timeout in interrupt data when set", async () => {
    const compiled = await compileGraph(
      waitGraph({ until: "{{ state.ready }}", timeout: "24h" }),
      {},
    );

    const result = await compiled.run({ threadId: "wait-until", onInterrupt: "fail" });
    expect(result.status).toBe("interrupted");

    const data = interruptData(result.interrupts);
    expect(data["until"]).toBe("{{ state.ready }}");
    expect(data["timeout"]).toBe("24h");
  });

  it("signal mode includes timeout in interrupt data when set", async () => {
    const compiled = await compileGraph(
      waitGraph({ signal: "deploy-finished", timeout: "1h" }),
      {},
    );

    const result = await compiled.run({ threadId: "wait-signal", onInterrupt: "fail" });
    expect(result.status).toBe("interrupted");

    const data = interruptData(result.interrupts);
    expect(data["signal"]).toBe("deploy-finished");
    expect(data["timeout"]).toBe("1h");
  });
});
