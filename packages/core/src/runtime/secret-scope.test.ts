import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";

function headerGraph(headers: Record<string, string>): GraphSpec {
  return {
    metadata: { name: "secret-scope" },
    nodes: [{ id: "call", type: "http", with: { url: "http://127.0.0.1:9/x", headers } }],
    edges: [
      { from: "START", to: "call" },
      { from: "call", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

async function sentHeaders(headers: Record<string, string>): Promise<unknown> {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  const result = await (await compileGraph(headerGraph(headers))).run();
  expect(result.status).toBe("completed");
  return fetchMock.mock.calls[0]?.[1]?.headers;
}

describe("secret template scope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("renders a set secret in sole and interpolated templates", async () => {
    vi.stubEnv("FGQA_SCOPE_DECOY", "decoy-scope-value");
    expect(
      await sentHeaders({
        A: "{{ secret.FGQA_SCOPE_DECOY }}",
        B: "t {{ secret.FGQA_SCOPE_DECOY }}",
      }),
    ).toMatchObject({ A: "decoy-scope-value", B: "t decoy-scope-value" });
  });

  it("renders an unset secret as an empty string, never null", async () => {
    expect(
      await sentHeaders({
        A: "{{ secret.FGQA_SCOPE_UNSET }}",
        B: "t {{ secret.FGQA_SCOPE_UNSET }}",
      }),
    ).toMatchObject({ A: "", B: "t " });
  });
});
