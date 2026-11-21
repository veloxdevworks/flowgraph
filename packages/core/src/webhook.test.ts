import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compileGraph } from "./compiler.js";
import type { GraphSpec } from "@flowgraph/spec";
import type { FlowgraphEvent } from "./events.js";

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

describe("webhook node secrets", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("redacts rendered secrets and sensitive headers from results and events", async () => {
    vi.stubEnv("FG_WEBHOOK_TOKEN", "webhook-secret-token-123");
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ echoed: { auth: headers["Authorization"], key: headers["X-Api-Key"] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const events: FlowgraphEvent[] = [];
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "webhook-secrets" },
      state: { channels: { apiKey: { type: "string" }, notifyResult: { type: "object" } } },
      nodes: [
        {
          id: "notify",
          type: "webhook",
          with: {
            url: "https://example.com/hook",
            headers: { Authorization: "Bearer {{ secret.FG_WEBHOOK_TOKEN }}", "X-Api-Key": "{{ state.apiKey }}" },
            body: { event: "started" },
            output: { to: "notifyResult" },
          },
        },
      ],
      edges: [
        { from: "START", to: "notify" },
        { from: "notify", to: "END" },
      ],
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, { checkpointer: "none", sinks: [(e) => { events.push(e); }] });
    const r = await compiled.run({ input: { apiKey: "state-api-key-456" } });
    expect(r.status).toBe("completed");
    const output = events.filter((e) => e.type === "node.output");
    expect(output).toHaveLength(1);
    const text = JSON.stringify({ result: r.state["notifyResult"], output });
    expect(text).not.toContain("webhook-secret-token-123");
    expect(text).not.toContain("state-api-key-456");
    expect(r.state["notifyResult"]).toMatchObject({ body: { echoed: { auth: "[REDACTED]", key: "[REDACTED]" } } });
  });
});
