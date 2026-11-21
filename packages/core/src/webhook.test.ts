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
      secrets: ["FG_WEBHOOK_TOKEN"],
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

describe("webhook node response headers", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const spec = (runtime: Record<string, unknown> = {}) =>
    ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "webhook-response-headers" },
      state: { channels: { token: { type: "string" }, notifyResult: { type: "object" } } },
      nodes: [
        {
          id: "notify",
          type: "webhook",
          with: {
            url: "https://example.com/hook",
            headers: { "X-Service-Token": "{{ state.token }}" },
            body: { event: "started" },
            output: { to: "notifyResult" },
          },
        },
      ],
      edges: [
        { from: "START", to: "notify" },
        { from: "notify", to: "END" },
      ],
      runtime,
    }) as unknown as GraphSpec;

  function echoFetch(extra: (headers: Headers) => Record<string, unknown> = () => ({})) {
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = (init?.headers as Record<string, string>)["X-Service-Token"];
      const headers = new Headers({ "content-type": "application/json", "x-request-id": "req-1" });
      headers.append("set-cookie", "session=first-session-cookie; HttpOnly");
      headers.append("set-cookie", "session=second-session-cookie; HttpOnly");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers,
        json: async () => ({ echoed: sent, cookies: headers.getSetCookie(), ...extra(headers) }),
      };
    }) as unknown as typeof fetch;
  }

  it("redacts set-cookie from the result and events", async () => {
    echoFetch();
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(spec(), { checkpointer: "none", sinks: [(e) => { events.push(e); }] });
    const r = await compiled.run({ input: { token: "service-token-789" } });
    expect(r.status).toBe("completed");
    const result = r.state["notifyResult"] as { headers: Record<string, string>; body: { cookies: string[] } };
    expect(result.headers["set-cookie"]).toBe("[REDACTED]");
    expect(result.headers["x-request-id"]).toBe("req-1");
    expect(result.body.cookies).toEqual(["[REDACTED]", "[REDACTED]"]);
    const text = JSON.stringify({ result, output: events.filter((e) => e.type === "node.output") });
    expect(text).not.toContain("session-cookie");
  });

  it("redacts custom token headers listed in runtime.secrets.redact.headers", async () => {
    echoFetch();
    const plain = await (await compileGraph(spec(), { checkpointer: "none" })).run({ input: { token: "service-token-789" } });
    expect(plain.state["notifyResult"]).toMatchObject({ body: { echoed: "service-token-789" } });

    echoFetch();
    const listed = await (
      await compileGraph(spec({ secrets: { redact: { headers: ["x-service-token"] } } }), { checkpointer: "none" })
    ).run({ input: { token: "service-token-789" } });
    expect(listed.state["notifyResult"]).toMatchObject({ body: { echoed: "[REDACTED]" } });
  });

  it("redacts a body that echoes only a cookie's name=value or its bare value", async () => {
    echoFetch(() => ({
      pair: "session=first-session-cookie",
      token: "first-session-cookie",
      sentence: "your session is second-session-cookie, keep it",
    }));
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(spec(), { checkpointer: "none", sinks: [(e) => { events.push(e); }] });
    const r = await compiled.run({ input: { token: "service-token-789" } });
    expect(r.status).toBe("completed");
    expect(r.state["notifyResult"]).toMatchObject({
      body: { pair: "[REDACTED]", token: "[REDACTED]", sentence: "your session is [REDACTED], keep it" },
    });
    const text = JSON.stringify({ state: r.state, output: events.filter((e) => e.type === "node.output") });
    expect(text).not.toContain("session-cookie");
  });

  it("uses the same marker in result.headers for built-in and custom sensitive headers", async () => {
    global.fetch = vi.fn(async () => {
      const headers = new Headers({
        "content-type": "application/json",
        authorization: "Bearer response-bearer-value",
        "x-service-token": "custom-response-token",
        "x-request-id": "req-1",
      });
      headers.append("set-cookie", "session=header-session-cookie; HttpOnly");
      return { ok: true, status: 200, statusText: "OK", headers, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const r = await (
      await compileGraph(spec({ secrets: { redact: { headers: ["X-Service-Token"] } } }), { checkpointer: "none" })
    ).run({ input: { token: "service-token-789" } });
    expect(r.status).toBe("completed");
    expect((r.state["notifyResult"] as { headers: Record<string, string> }).headers).toEqual({
      "content-type": "application/json",
      authorization: "[REDACTED]",
      "set-cookie": "[REDACTED]",
      "x-service-token": "[REDACTED]",
      "x-request-id": "req-1",
    });
  });
});
