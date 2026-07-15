import { describe, it, expect, afterEach } from "vitest";
import { compileGraph } from "../compiler.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { FlowgraphEvent } from "../events.js";
import { closeWebhookServers } from "../runtime/webhook-server.js";

function waitGraph(withConfig: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "wait-graph" },
    state: { channels: { ready: { type: "boolean", default: false }, approval: { type: "object" } } },
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
    runtime: {
      checkpoint: { enabled: true, backend: "memory" },
      webhookServer: { port: 0 },
    },
  } as unknown as GraphSpec;
}

function interruptData(interrupts: { payload?: unknown }[] | undefined): Record<string, unknown> {
  const payload = interrupts?.[0]?.payload as { data?: Record<string, unknown> } | undefined;
  return payload?.data ?? {};
}

describe("wait node", () => {
  afterEach(async () => {
    await closeWebhookServers();
  });

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

  it("signal mode includes timeout in interrupt data when set", async () => {
    const compiled = await compileGraph(
      waitGraph({ signal: "deploy-finished", timeout: "1h" }),
      {},
    );

    const result = await compiled.run({ threadId: "wait-signal", onInterrupt: "fail" });
    expect(result.status).toBe("interrupted");

    const data = interruptData(result.interrupts);
    expect(data["signal"]).toBe("deploy-finished");
    expect(data["mode"]).toBe("signal");
    expect(data["timeout"]).toBe("1h");
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
    expect(data["mode"]).toBe("until");
    expect(data["timeout"]).toBe("24h");
  });

  it("webhook mode interrupts with kind custom and maps resume payload to output", async () => {
    const compiled = await compileGraph(
      waitGraph({
        webhook: true,
        output: { to: "approval" },
      }),
      {},
    );
    const r1 = await compiled.run({ threadId: "wait-wh-1", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.kind).toBe("custom");
    const data = interruptData(r1.interrupts);
    expect(data["mode"]).toBe("webhook");
    expect(typeof data["webhookUrl"]).toBe("string");
    expect(String(data["webhookUrl"])).toContain("/webhooks/wait-wh-1/gate");

    const r2 = await compiled.resume({
      threadId: "wait-wh-1",
      resume: { approved: true },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect(r2.state["approval"]).toEqual({ approved: true });
  });

  it("webhook mode rejects resume payload missing schema.required fields", async () => {
    const compiled = await compileGraph(
      waitGraph({
        webhook: {
          schema: {
            type: "object",
            required: ["approved"],
            properties: { approved: { type: "boolean" } },
          },
        },
        output: { to: "approval" },
      }),
      {},
    );
    const r1 = await compiled.run({ threadId: "wait-wh-schema", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");

    const r2 = await compiled.resume({
      threadId: "wait-wh-schema",
      resume: { status: "pending" },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("error");
    expect(r2.error?.message).toContain("missing required field(s): approved");
  });
});
