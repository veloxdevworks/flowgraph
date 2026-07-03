import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import * as core from "@veloxdevworks/flowgraph-core";
import { buildProviders } from "./providers.js";

describe("buildProviders", () => {
  beforeEach(() => {
    vi.spyOn(core, "createLangChainProviderFromConfig").mockImplementation(async (name: string) => ({
      name,
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false },
      run: async () => ({ output: {}, steps: [], stopReason: "done" as const }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds named providers from spec.providers", async () => {
    const spec = {
      metadata: { name: "test" },
      nodes: [],
      edges: [],
      providers: {
        main: { kind: "langchain" as const, vendor: "anthropic" as const, model: "claude-3-5-sonnet-latest" },
      },
    } as unknown as GraphSpec;

    const providers = await buildProviders(spec);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.name).toBe("main");
  });

  it("synthesizes provider when defaults.provider is a bare vendor name", async () => {
    const spec = {
      metadata: { name: "test" },
      nodes: [],
      edges: [],
      config: { defaults: { provider: "openai", model: "gpt-4o" } },
    } as unknown as GraphSpec;

    const providers = await buildProviders(spec);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.name).toBe("openai");
  });

  it("does not duplicate when defaults.provider matches a providers key", async () => {
    const spec = {
      metadata: { name: "test" },
      nodes: [],
      edges: [],
      providers: {
        main: { kind: "langchain" as const, vendor: "anthropic" as const },
      },
      config: { defaults: { provider: "main" } },
    } as unknown as GraphSpec;

    const providers = await buildProviders(spec);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.name).toBe("main");
  });

  it("builds claude providers via dynamic import", async () => {
    vi.doMock("@veloxdevworks/flowgraph-provider-claude", () => ({
      createClaudeProviderFromConfig: vi.fn(async (name: string) => ({
        name,
        capabilities: { toolCalling: true, structuredOutput: true, streaming: true },
        run: async () => ({ output: {}, steps: [], stopReason: "done" as const }),
      })),
    }));

    const spec = {
      metadata: { name: "test" },
      nodes: [],
      edges: [],
      providers: {
        claude: { kind: "claude" as const, model: "claude-sonnet-4.5" },
      },
    } as unknown as GraphSpec;

    const { buildProviders: build } = await import("./providers.js");
    const providers = await build(spec);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.name).toBe("claude");
  });
});
