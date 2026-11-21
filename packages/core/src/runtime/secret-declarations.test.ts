import { describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { validateSpec } from "../loader.js";
import { compileGraph } from "../compiler.js";
import { providerSecretDiagnostics, secretNamesIn, secretReferenceDiagnostics } from "./secret-declarations.js";

function graph(extra: Record<string, unknown>, nodes: unknown[] = [{ id: "a", type: "shell", with: { command: "true" } }]): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "declared" },
    nodes,
    edges: [
      { from: "START", to: (nodes[0] as { id: string }).id },
      { from: (nodes[0] as { id: string }).id, to: "END" },
    ],
    ...extra,
  } as unknown as GraphSpec;
}

const undeclared = (diagnostics: { code: string }[]) => diagnostics.filter((d) => d.code === "SECRET_UNDECLARED");

describe("secretNamesIn", () => {
  it("finds dotted and quoted names", () => {
    expect(secretNamesIn('Bearer {{ secret.API_TOKEN }} {{ secret["OTHER"] }}')).toEqual(["API_TOKEN", "OTHER"]);
  });

  it("leaves computed names and other roots to run time", () => {
    expect(secretNamesIn("{{ secret[state.key] }} {{ state.secret.X }} {{ input.secret }}")).toEqual([]);
  });
});

describe("secretReferenceDiagnostics", () => {
  it("flags an undeclared name in node config with its path", () => {
    const spec = graph({}, [{ id: "call", type: "http", with: { url: "http://x", headers: { A: "{{ secret.TOKEN }}" } } }]);
    expect(secretReferenceDiagnostics(spec)).toEqual([
      {
        severity: "error",
        code: "SECRET_UNDECLARED",
        path: "nodes.call.with.headers.A",
        message: 'Node "call" reads secret "TOKEN", which the graph does not declare. Add TOKEN to the top-level secrets: list.',
      },
    ]);
  });

  it("accepts a declared name", () => {
    const spec = graph({ secrets: ["TOKEN"] }, [{ id: "call", type: "http", with: { url: "http://x", headers: { A: "{{ secret.TOKEN }}" } } }]);
    expect(secretReferenceDiagnostics(spec)).toEqual([]);
  });

  it("checks mcpServers entries", () => {
    const spec = graph({ mcpServers: { gh: { transport: "stdio", command: "gh-mcp", env: { GH_TOKEN: "{{ secret.GH_TOKEN }}" } } } });
    expect(secretReferenceDiagnostics(spec)).toMatchObject([
      { path: "mcpServers.gh.env.GH_TOKEN", message: expect.stringContaining('MCP server "gh" reads secret "GH_TOKEN"') },
    ]);
  });

  it("checks an inline subgraph against its own list, not its parent's", () => {
    const child = graph({}, [{ id: "inner", type: "http", with: { url: "http://x/{{ secret.TOKEN }}" } }]);
    const parent = graph({ secrets: ["TOKEN"] }, [{ id: "sub", type: "subgraph", spec: child }]);
    expect(secretReferenceDiagnostics(parent)).toMatchObject([{ path: "nodes.sub.spec.nodes.inner.with.url" }]);
  });

  it("makes compileGraph refuse the graph, including names in mcpServers and map inner nodes", async () => {
    const mapped = graph({}, [
      {
        id: "each",
        type: "map",
        with: { over: "{{ state.items }}", node: { id: "inner", type: "http", with: { url: "http://x/{{ secret.INNER }}" } } },
      },
    ]);
    await expect(compileGraph(mapped)).rejects.toThrow('reads secret "INNER", which the graph does not declare');
    const mcp = graph({ mcpServers: { gh: { transport: "stdio", command: "gh-mcp", env: { T: "{{ secret.GH }}" } } } });
    await expect(compileGraph(mcp)).rejects.toThrow('mcpServers.gh.env.T: MCP server "gh" reads secret "GH"');
    await expect(compileGraph({ ...mcp, secrets: ["GH"] })).resolves.toBeDefined();
  });

  it("is part of validateSpec", () => {
    const spec = graph({}, [{ id: "call", type: "http", with: { url: "http://x/{{ secret.TOKEN }}" } }]);
    expect(undeclared(validateSpec(spec))).toHaveLength(1);
  });
});

describe("providerSecretDiagnostics", () => {
  it("flags an undeclared apiKeyEnv", () => {
    const spec = graph({ providers: { lc: { kind: "langchain", vendor: "openai", apiKeyEnv: "MY_KEY" } } });
    expect(providerSecretDiagnostics(spec)).toEqual([
      {
        severity: "error",
        code: "SECRET_UNDECLARED",
        path: "providers.lc.apiKeyEnv",
        message: 'Provider "lc" apiKeyEnv reads secret "MY_KEY", which the graph does not declare. Add MY_KEY to the top-level secrets: list.',
      },
    ]);
  });

  it("accepts a declared apiKeyEnv", () => {
    const spec = graph({ secrets: ["MY_KEY"], providers: { lc: { kind: "langchain", vendor: "openai", apiKeyEnv: "MY_KEY" } } });
    expect(providerSecretDiagnostics(spec)).toEqual([]);
  });

  it("flags a baseUrl that would receive an undeclared default key", () => {
    const spec = graph({ providers: { lc: { kind: "langchain", vendor: "openai", baseUrl: "http://proxy/v1" } } });
    expect(providerSecretDiagnostics(spec)).toMatchObject([
      { path: "providers.lc.baseUrl", message: expect.stringContaining("sends its default API key OPENAI_API_KEY to baseUrl") },
    ]);
    expect(providerSecretDiagnostics({ ...spec, secrets: ["OPENAI_API_KEY"] })).toEqual([]);
  });

  it("leaves vendor default keys alone when no baseUrl is set", () => {
    const spec = graph({ providers: { lc: { kind: "langchain", vendor: "openai" } } });
    expect(providerSecretDiagnostics(spec)).toEqual([]);
  });

  it("makes compileGraph refuse the graph", async () => {
    const spec = graph({ providers: { lc: { kind: "langchain", vendor: "openai", apiKeyEnv: "MY_KEY" } } });
    await expect(compileGraph(spec)).rejects.toThrow(/apiKeyEnv reads secret "MY_KEY", which the graph does not declare/);
  });
});
