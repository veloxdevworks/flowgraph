import { describe, expect, it } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { validateSpec } from "../loader.js";
import { createLangChainProvider } from "./langchain/index.js";
import { defineProvider } from "./types.js";
import { AIMessage } from "@langchain/core/messages";

function graph(nodes: unknown[]): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "provider-diagnostics" },
    nodes,
    edges: [
      { from: "START", to: (nodes[0] as { id: string }).id },
      { from: (nodes[0] as { id: string }).id, to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  });
}

describe("provider option diagnostics", () => {
  it("validateSpec rejects a model router with allMatches", () => {
    const spec = graph([
      {
        id: "route",
        type: "router",
        with: {
          mode: "model",
          match: "allMatches",
          routes: { a: { to: "END" }, b: { default: true, to: "END" } },
        },
      },
    ]);
    const diags = validateSpec(spec);
    const hit = diags.filter((d) => d.path?.includes("match"));
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit[0]!.severity).toBe("error");
    expect(hit[0]!.message).toContain("mode: model cannot use match: allMatches");
  });

  it("compileGraph refuses a model router with allMatches", async () => {
    const spec = graph([
      {
        id: "route",
        type: "router",
        with: {
          mode: "model",
          match: "allMatches",
          routes: { a: { to: "END" }, b: { default: true, to: "END" } },
        },
      },
    ]);
    await expect(compileGraph(spec)).rejects.toThrow(/allMatches/);
  });

  it("warns when a LangChain agent requests a builtin tool", () => {
    const spec = graph([
      {
        id: "agent",
        type: "agent",
        provider: "langchain",
        with: { prompt: "Hi", tools: [{ builtin: "Bash" }] },
      },
    ]);
    const diags = validateSpec(spec);
    const hit = diags.filter((d) => d.code === "PROVIDER_CONFIG_UNSUPPORTED");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.severity).toBe("warning");
    expect(hit[0]!.message).toContain("builtin");
    expect(hit[0]!.path).toContain("nodes.agent");
  });

  it("warns when a node model is not in the provider's known list, and still forwards it", async () => {
    const provider = createLangChainProvider(
      {
        async invoke() {
          return new AIMessage({ content: "ok" });
        },
      },
      { models: ["gpt-4o"] },
    );
    const spec = graph([
      {
        id: "agent",
        type: "agent",
        provider: "langchain",
        model: "mystery-model",
        with: { prompt: "Hi", output: { to: "out" } },
      },
    ]);
    // offline validate has no adapter, so no models list — compile-time check uses the adapter
    const compiled = await compileGraph(spec, { providers: [provider] });
    // compile does not throw on warnings
    expect(compiled).toBeDefined();
    const fromValidate = (await import("./diagnostics.js")).providerConfigDiagnostics(spec, [
      provider,
    ]);
    expect(
      fromValidate.some(
        (d) => d.code === "PROVIDER_MODEL_UNKNOWN" && d.message.includes("mystery-model"),
      ),
    ).toBe(true);
  });

  it("surfaces a provider validate() error at compile time", async () => {
    const provider = defineProvider({
      name: "strict",
      capabilities: { toolCalling: false, structuredOutput: false, streaming: false },
      validate: () => [{ severity: "error", message: "option 'foo' is not supported" }],
      async run() {
        return { output: {}, stopReason: "done" };
      },
    });
    const spec = graph([
      { id: "agent", type: "agent", provider: "strict", with: { prompt: "Hi" } },
    ]);
    await expect(compileGraph(spec, { providers: [provider] })).rejects.toThrow(
      /option 'foo' is not supported/,
    );
  });
});
