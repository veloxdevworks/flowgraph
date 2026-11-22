import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
import { registerFunction } from "./nodes/function.js";

function graph(over: Record<string, unknown> = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "policy-settings" },
    nodes: [{ id: "a", type: "function", with: { fn: "policyFlaky" } }],
    edges: [
      { from: "START", to: "a" },
      { from: "a", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
    ...over,
  });
}

describe("canonical retry and timeout take effect", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("validateSpec rejects http with.retry and with.timeout", () => {
    const retrySpec = graph({
      nodes: [
        {
          id: "fetch",
          type: "http",
          with: { url: "https://example.com", retry: { maxAttempts: 4 } },
        },
      ],
      edges: [
        { from: "START", to: "fetch" },
        { from: "fetch", to: "END" },
      ],
    });
    const retry = validateSpec(retrySpec).filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(retry.length).toBeGreaterThanOrEqual(1);
    expect(retry[0]).toMatchObject({
      severity: "error",
      code: "NODE_CONFIG_ERROR",
      path: "nodes.fetch.with",
    });
    expect(retry[0]!.message).toContain("retry");

    const timeoutSpec = graph({
      nodes: [
        { id: "fetch", type: "http", with: { url: "https://example.com", timeout: "200ms" } },
      ],
      edges: [
        { from: "START", to: "fetch" },
        { from: "fetch", to: "END" },
      ],
    });
    const timeout = validateSpec(timeoutSpec).filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(timeout.length).toBeGreaterThanOrEqual(1);
    expect(timeout[0]).toMatchObject({
      severity: "error",
      code: "NODE_CONFIG_ERROR",
      path: "nodes.fetch.with",
    });
    expect(timeout[0]!.message).toContain("timeout");
  });

  it("runtime.retry applies when the node has no retry of its own", async () => {
    let attempts = 0;
    registerFunction("policyRetryDefault", () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
      return { ok: true };
    });
    const compiled = await compileGraph(
      graph({
        nodes: [{ id: "a", type: "function", with: { fn: "policyRetryDefault" } }],
        runtime: {
          checkpoint: { enabled: false },
          retry: { maxAttempts: 3, backoff: "fixed", baseMs: 1, jitter: false },
        },
      }),
    );
    const r = await compiled.run();
    expect(r.status).toBe("completed");
    expect(attempts).toBe(3);
  });

  it("node retry overrides runtime.retry", async () => {
    let attempts = 0;
    registerFunction("policyRetryOverride", () => {
      attempts += 1;
      throw new Error("always");
    });
    const compiled = await compileGraph(
      graph({
        nodes: [
          {
            id: "a",
            type: "function",
            retry: { maxAttempts: 2, backoff: "fixed", baseMs: 1, jitter: false },
            with: { fn: "policyRetryOverride" },
          },
        ],
        runtime: {
          checkpoint: { enabled: false },
          retry: { maxAttempts: 5, backoff: "fixed", baseMs: 1, jitter: false },
        },
      }),
    );
    const r = await compiled.run();
    expect(r.status).toBe("error");
    expect(attempts).toBe(2);
  });

  it("runtime.timeoutDefault times out a node that has no timeout of its own", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerFunction("policyTimeoutDefault", async () => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true };
    });
    const compiled = await compileGraph(
      graph({
        nodes: [{ id: "a", type: "function", with: { fn: "policyTimeoutDefault" } }],
        runtime: { checkpoint: { enabled: false }, timeoutDefault: "20ms" },
      }),
      { store: "none" },
    );
    vi.useFakeTimers();
    const running = compiled.run();
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await ready;
    await vi.advanceTimersByTimeAsync(19);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const r = await running;
    expect(r.status).toBe("error");
    expect(String(r.error?.message ?? r.error)).toMatch(/timed out/i);
  });

  it("node timeout overrides runtime.timeoutDefault", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerFunction("policyTimeoutOverride", async () => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true };
    });
    const compiled = await compileGraph(
      graph({
        nodes: [
          {
            id: "a",
            type: "function",
            timeout: "200ms",
            with: { fn: "policyTimeoutOverride" },
          },
        ],
        runtime: { checkpoint: { enabled: false }, timeoutDefault: "10ms" },
      }),
      { store: "none" },
    );
    vi.useFakeTimers();
    const running = compiled.run();
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await ready;
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    const r = await running;
    expect(r.status).toBe("completed");
  });
});
