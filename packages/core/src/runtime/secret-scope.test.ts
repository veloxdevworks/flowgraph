import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";

function headerGraph(headers: Record<string, string>, secrets: string[] = ["FGQA_SCOPE_DECOY", "FGQA_SCOPE_UNSET"]): GraphSpec {
  return {
    metadata: { name: "secret-scope" },
    secrets,
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

  it.each([
    ["a literal name", "{{ secret.FGQA_SCOPE_DECOY }}"],
    ["a computed name", "{{ secret[config.vars.key] }}"],
  ])("fails the node on %s the graph does not declare", async (_label, template) => {
    vi.stubEnv("FGQA_SCOPE_DECOY", "decoy-scope-value");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const spec = headerGraph({ A: template }, []);
    spec.config = { vars: { key: "FGQA_SCOPE_DECOY" } };
    const result = await (await compileGraph(spec)).run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain(
      'http node "call" reads secret "FGQA_SCOPE_DECOY", which the graph does not declare. Add FGQA_SCOPE_DECOY to the top-level secrets: list.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let a child graph read what only its parent declares", async () => {
    vi.stubEnv("FGQA_SCOPE_DECOY", "decoy-scope-value");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const child = headerGraph({ A: "{{ secret.FGQA_SCOPE_DECOY }}" }, []);
    const parent = {
      metadata: { name: "secret-parent" },
      secrets: ["FGQA_SCOPE_DECOY"],
      nodes: [{ id: "sub", type: "subgraph", spec: child }],
      edges: [
        { from: "START", to: "sub" },
        { from: "sub", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec;
    const result = await (await compileGraph(parent)).run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain('reads secret "FGQA_SCOPE_DECOY", which the graph does not declare');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
