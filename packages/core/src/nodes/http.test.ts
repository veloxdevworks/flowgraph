import { afterEach, describe, expect, it, vi } from "vitest";
import { compileGraph } from "../compiler.js";
import type { GraphSpec } from "@flowgraph/spec";
import type { FlowgraphEvent } from "../events.js";
import { redactHeaders } from "./http.js";
import { redactSensitiveFields, redactUrlSecrets } from "./http-request.js";

function httpGraph(withConfig: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "http-graph" },
    state: { channels: {} },
    nodes: [
      {
        id: "call",
        type: "http",
        with: withConfig,
      },
    ],
    edges: [
      { from: "START", to: "call" },
      { from: "call", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("transcript masking", () => {
  it("masks URL credentials and sensitive query parameters with the shared marker, unencoded", () => {
    expect(redactUrlSecrets("https://user:pass@example.com/p?token=abc&q=1")).toBe(
      "https://[REDACTED]:[REDACTED]@example.com/p?token=[REDACTED]&q=1",
    );
    expect(redactUrlSecrets("https://example.com/p?q=1")).toBe("https://example.com/p?q=1");
  });

  it("masks sensitive field names with the shared marker", () => {
    expect(redactSensitiveFields({ password: "pw", nested: [{ apiKey: "k", name: "n" }] })).toEqual({
      password: "[REDACTED]",
      nested: [{ apiKey: "[REDACTED]", name: "n" }],
    });
  });
});

describe("redactHeaders", () => {
  it("masks sensitive header names case-insensitively", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer secret-token",
        "X-Api-Key": "abc123",
        "Content-Type": "application/json",
        Accept: "text/html",
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      "X-Api-Key": "[REDACTED]",
      "Content-Type": "application/json",
      Accept: "text/html",
    });
  });
});

describe("http node", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("renders config vars and explicit secrets in the same scope", async () => {
    vi.stubEnv("FGQA_DECOY", "decoy-only");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const spec = httpGraph({ url: "https://example.com/{{ config.vars.path }}", headers: { Authorization: "{{ secret.FGQA_DECOY }}" } });
    spec.config = { vars: { path: "configured" } };
    spec.secrets = ["FGQA_DECOY"];
    const result = await (await compileGraph(spec)).run();
    expect(result.status).toBe("completed");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.com/configured");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "decoy-only" });
  });

  it("emits node.output with request and response, redacting Authorization", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "x-from": "mock" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(
      httpGraph({
        url: "https://example.com/api",
        method: "POST",
        headers: {
          Authorization: "Bearer super-secret",
          "X-Custom": "visible",
        },
        body: { hello: "world" },
        expect: { status: [200] },
      }),
      {
        sinks: [(e) => {
          events.push(e);
        }],
      },
    );

    const result = await compiled.run({ threadId: "http-req-res" });
    expect(result.status).toBe("completed");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe("https://example.com/api");
    expect(init?.method).toBe("POST");

    const output = events.find((e) => e.type === "node.output");
    expect(output?.scope.nodeId).toBe("call");

    const data = output?.data as {
      request: {
        method: string;
        url: string;
        headers: Record<string, string>;
        body: unknown;
      };
      response: {
        status: number;
        headers: Record<string, string>;
        body: unknown;
      };
    };

    expect(data.request.method).toBe("POST");
    expect(data.request.url).toBe("https://example.com/api");
    expect(data.request.headers.Authorization).toBe("[REDACTED]");
    expect(data.request.headers["X-Custom"]).toBe("visible");
    expect(data.request.body).toEqual({ hello: "world" });

    expect(data.response.status).toBe(200);
    expect(data.response.body).toEqual({ ok: true });
    expect(data.response.headers["x-from"]).toBe("mock");
  });
});

describe("http node transcript headers", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("masks headers listed in runtime.secrets.redact.headers with the same marker as built-in ones", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const spec = httpGraph({
      url: "https://example.com/api",
      headers: { Authorization: "Bearer built-in-token", "X-Service-Token": "custom-token-value", "X-Custom": "visible" },
    });
    spec.runtime = { ...spec.runtime, secrets: { redact: { headers: ["x-service-token"] } } } as GraphSpec["runtime"];
    const events: FlowgraphEvent[] = [];
    const r = await (await compileGraph(spec, { sinks: [(e) => { events.push(e); }] })).run({});
    expect(r.status).toBe("completed");
    const data = events.find((e) => e.type === "node.output")?.data as { request: { headers: Record<string, string> } };
    expect(data.request.headers).toMatchObject({
      Authorization: "[REDACTED]",
      "X-Service-Token": "[REDACTED]",
      "X-Custom": "visible",
    });
  });

  it("masks the URL and sensitive response headers in the event and registers response secrets", async () => {
    global.fetch = vi.fn(async () => {
      const headers = new Headers({
        "content-type": "application/json",
        "x-service-token": "custom-response-token",
        "x-request-id": "req-1",
      });
      headers.append("set-cookie", "sid=s3cr3tid; HttpOnly");
      headers.append("set-cookie", "theme=default; Path=/");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers,
        json: async () => ({
          sid: "s3cr3tid",
          token: "custom-response-token",
          pair: "theme=default",
          text: "use default settings",
        }),
      };
    }) as unknown as typeof fetch;
    const spec = httpGraph({ url: "https://user:pass@example.com/api?token=query-token&q=1", output: { to: "res" } });
    spec.state = { channels: { res: { type: "object" } } };
    spec.runtime = { ...spec.runtime, secrets: { redact: { headers: ["x-service-token"] } } } as GraphSpec["runtime"];
    const events: FlowgraphEvent[] = [];
    const r = await (await compileGraph(spec, { sinks: [(e) => { events.push(e); }] })).run({});
    expect(r.status).toBe("completed");

    const data = events.find((e) => e.type === "node.output")?.data as {
      request: { url: string };
      response: { headers: Record<string, string> };
    };
    expect(data.request.url).toBe("https://[REDACTED]:[REDACTED]@example.com/api?token=[REDACTED]&q=1");
    expect(data.response.headers).toEqual({
      "content-type": "application/json",
      "set-cookie": "[REDACTED]",
      "x-service-token": "[REDACTED]",
      "x-request-id": "req-1",
    });

    const res = r.state["res"] as { body: Record<string, string>; headers: Record<string, string> };
    expect(res.body).toEqual({ sid: "[REDACTED]", token: "[REDACTED]", pair: "[REDACTED]", text: "use default settings" });
    // result.headers is not masked by name: every header stays, and only registered values are redacted.
    expect(Object.keys(res.headers).sort()).toEqual(["content-type", "set-cookie", "x-request-id", "x-service-token"]);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["x-request-id"]).toBe("req-1");
    const text = JSON.stringify({ state: r.state, events });
    expect(text).not.toContain("s3cr3tid");
    expect(text).not.toContain("custom-response-token");
    expect(text).not.toContain("query-token");
  });
});
