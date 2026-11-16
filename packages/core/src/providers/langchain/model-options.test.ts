import { describe, it, expect } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { compileGraph, type GraphSpec } from "../../index.js";
import { providerConfigDiagnostics } from "../diagnostics.js";
import { createLangChainProvider, type ChatModelLike } from "./index.js";

type Call = { input: BaseMessage[]; options: unknown; bound?: Record<string, unknown> };

function recordingModel(calls: Call[]): ChatModelLike {
  const model: ChatModelLike = {
    async invoke(input: BaseMessage[], options?: unknown) {
      calls.push({ input, options });
      return new AIMessage({ content: "ok" });
    },
    bind(kwargs: Record<string, unknown>) {
      const bound: ChatModelLike = {
        async invoke(input: BaseMessage[], options?: unknown) {
          calls.push({ input, options, bound: kwargs });
          return new AIMessage({ content: "ok" });
        },
      };
      return bound;
    },
  };
  return model;
}

function agentSpec(withBlock: Record<string, unknown>, model?: string): GraphSpec {
  return {
    metadata: { name: "lc-options" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [
      {
        id: "agent",
        type: "agent",
        provider: "langchain",
        ...(model ? { model } : {}),
        with: { prompt: "Hi", output: { to: "answer" }, ...withBlock },
      },
    ],
    edges: [
      { from: "START", to: "agent" },
      { from: "agent", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("LangChain forwards model and maxTokens", () => {
  it("falls back to bind and call options for a model it cannot rebuild", async () => {
    const calls: Call[] = [];
    const provider = createLangChainProvider(recordingModel(calls));
    const compiled = await compileGraph(agentSpec({ maxTokens: 7 }, "gpt-override"), {
      providers: [provider],
    });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bound).toEqual({ model: "gpt-override", maxTokens: 7 });
    expect(calls[0]!.options).toMatchObject({ model: "gpt-override", maxTokens: 7 });
    expect(calls[0]!.options).toHaveProperty("signal");
  });

  it("passes call options when the model can be neither rebuilt nor bound", async () => {
    const calls: Call[] = [];
    const model: ChatModelLike = {
      async invoke(input: BaseMessage[], options?: unknown) {
        calls.push({ input, options });
        return new AIMessage({ content: "ok" });
      },
    };
    const provider = createLangChainProvider(model);
    const compiled = await compileGraph(agentSpec({ maxTokens: 11 }, "other-model"), {
      providers: [provider],
    });
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ model: "other-model", maxTokens: 11 });
  });

  it("warns at compile, naming the node, when the model cannot be rebuilt with the overrides", async () => {
    const plain: ChatModelLike = { async invoke() { return new AIMessage({ content: "ok" }); } };
    const compiled = await compileGraph(agentSpec({ maxTokens: 11 }, "other-model"), {
      providers: [createLangChainProvider(plain)],
    });
    const warning = compiled.diagnostics.find((d) => d.message.includes("withModelOverrides"));
    expect(warning).toMatchObject({ severity: "warning", code: "PROVIDER_CONFIG_UNSUPPORTED", path: "nodes.agent.with" });
    expect(warning!.message).toContain('Node "agent"');
    expect(warning!.message).toContain("model and maxTokens");
    expect(warning!.message).toContain("may ignore");
    const r = await compiled.run({ input: {} });
    expect(r.issues?.some((i) => i.nodeId === "agent" && i.message.includes("withModelOverrides"))).toBe(true);
  });

  it("does not warn when there is nothing to override, or withModelOverrides is given", () => {
    const plain: ChatModelLike = { async invoke() { return new AIMessage({ content: "ok" }); } };
    const unwarned = (spec: GraphSpec, provider = createLangChainProvider(plain)) =>
      providerConfigDiagnostics(spec, [provider]).filter((d) => d.message.includes("withModelOverrides"));
    expect(unwarned(agentSpec({}))).toEqual([]);
    expect(unwarned(agentSpec({ maxTokens: 5 }, "m"), createLangChainProvider(plain, { withModelOverrides: (m) => m }))).toEqual([]);
  });
});
