import { describe, expect, it } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { validateSpec } from "../loader.js";
import { createLangChainProvider } from "./langchain/index.js";
import { defineProvider } from "./types.js";
import { registerProvider } from "./registry.js";
import { AIMessage } from "@langchain/core/messages";

function graph(nodes: unknown[], extra: Record<string, unknown> = {}): GraphSpec {
  return GraphSpecSchema.parse({
    ...extra,
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

  it("reports compile warnings on the compiled graph and on every run result", async () => {
    const provider = createLangChainProvider(
      { async invoke() { return new AIMessage({ content: "ok" }); } },
      { models: ["gpt-4o"] },
    );
    const spec = graph([
      {
        id: "agent",
        type: "agent",
        provider: "langchain",
        model: "mystery-model",
        with: { prompt: "Hi", tools: [{ builtin: ["Bash"] }], output: { to: "out" } },
      },
    ]);
    const compiled = await compileGraph(spec, { providers: [provider] });
    expect(compiled.diagnostics.map((d) => d.code).sort()).toEqual([
      "PROVIDER_CONFIG_UNSUPPORTED",
      "PROVIDER_MODEL_UNKNOWN",
    ]);
    expect(compiled.diagnostics.every((d) => d.severity === "warning")).toBe(true);
    for (let i = 0; i < 2; i++) {
      const r = await compiled.run({ input: {} });
      expect(r.status).toBe("completed");
      const codes = (r.issues ?? []).map((issue) => [issue.code, issue.severity, issue.nodeId]);
      expect(codes).toContainEqual(["PROVIDER_MODEL_UNKNOWN", "warning", "agent"]);
      expect(codes).toContainEqual(["PROVIDER_CONFIG_UNSUPPORTED", "warning", "agent"]);
    }
  });

  it("checks known models and builtin tools offline from the providers block", () => {
    const spec = graph(
      [
        {
          id: "agent",
          type: "agent",
          provider: "lc",
          model: "mystery-model",
          with: { prompt: "Hi", tools: [{ builtin: "Bash" }] },
        },
      ],
      { providers: { lc: { kind: "langchain", vendor: "openai", model: "gpt-4o" } } },
    );
    const diags = validateSpec(spec);
    const unknown = diags.find((d) => d.code === "PROVIDER_MODEL_UNKNOWN");
    expect(unknown?.severity).toBe("warning");
    expect(unknown?.message).toContain("mystery-model");
    expect(unknown?.message).toContain("gpt-4o");
    expect(diags.filter((d) => d.code === "PROVIDER_CONFIG_UNSUPPORTED")).toHaveLength(1);
  });

  it("runs a registered provider's own validate() offline", () => {
    registerProvider(defineProvider({
      name: "offline-custom",
      capabilities: { toolCalling: false, structuredOutput: false, streaming: false, models: ["m1"] },
      validate: () => [{ severity: "error", message: "option 'foo' is not supported" }],
      async run() {
        return { output: {}, stopReason: "done" };
      },
    }));
    const spec = graph([
      { id: "agent", type: "agent", provider: "offline-custom", model: "m2", with: { prompt: "Hi" } },
    ]);
    const diags = validateSpec(spec);
    expect(diags).toContainEqual(expect.objectContaining({ code: "PROVIDER_CONFIG_ERROR", severity: "error", message: "option 'foo' is not supported" }));
    expect(diags).toContainEqual(expect.objectContaining({ code: "PROVIDER_MODEL_UNKNOWN", severity: "warning" }));
  });
});
