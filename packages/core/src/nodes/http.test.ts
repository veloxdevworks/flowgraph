import { afterEach, describe, expect, it, vi } from "vitest";
import { compileGraph } from "../compiler.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { FlowgraphEvent } from "../events.js";
import { redactHeaders } from "./http.js";

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
      Authorization: "***",
      "X-Api-Key": "***",
      "Content-Type": "application/json",
      Accept: "text/html",
    });
  });
});

describe("http node", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits node.output with request and response, redacting Authorization", async () => {
    const fetchMock = vi.fn(async () =>
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
    expect(data.request.headers.Authorization).toBe("***");
    expect(data.request.headers["X-Custom"]).toBe("visible");
    expect(data.request.body).toEqual({ hello: "world" });

    expect(data.response.status).toBe(200);
    expect(data.response.body).toEqual({ ok: true });
    expect(data.response.headers["x-from"]).toBe("mock");
  });
});
