import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compileGraph } from "./compiler.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

describe("webhook node (emit)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ notified: true }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("calls fetch once and does not re-fire on replay after interrupt/resume", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "webhook-emit" },
      state: { channels: { notifyResult: { type: "object" } } },
      nodes: [
        {
          id: "notify",
          type: "webhook",
          with: {
            url: "https://example.com/hook",
            method: "POST",
            body: { event: "started" },
            output: { to: "notifyResult" },
          },
        },
        {
          id: "gate",
          type: "wait",
          with: { signal: "done" },
        },
      ],
      edges: [
        { from: "START", to: "notify" },
        { from: "notify", to: "gate" },
        { from: "gate", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const r1 = await compiled.run({ threadId: "wh-emit-1", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const r2 = await compiled.resume({
      threadId: "wh-emit-1",
      resume: { done: true },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((r2.state["notifyResult"] as { status: number }).status).toBe(200);
  });
});
