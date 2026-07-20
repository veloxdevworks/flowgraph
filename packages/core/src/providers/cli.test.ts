import { describe, it, expect, vi } from "vitest";
import {
  createCliProvider,
  detectLocalCli,
  cliVendorForProviderKind,
  apiKeyEnvForProviderKind,
  hasApiKey,
  defaultBinaryFor,
} from "./cli.js";
import type { ProviderRunContext } from "./types.js";

function fakeCtx(partial: Partial<ProviderRunContext> = {}): ProviderRunContext {
  return {
    node: {
      workspace: "/tmp/ws",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ProviderRunContext["node"],
    invokeTool: async () => undefined,
    checkToolCall: async (_n, a) => a,
    reportToolResult: async (_n, _a, r) => r,
    emit: vi.fn(),
    ...partial,
  };
}

describe("cli provider helpers", () => {
  it("maps provider kinds to CLI vendors", () => {
    expect(cliVendorForProviderKind("claude")).toBe("claude");
    expect(cliVendorForProviderKind("cursor")).toBe("cursor");
    expect(cliVendorForProviderKind("langchain", "openai")).toBe("codex");
    expect(cliVendorForProviderKind("langchain", "xai")).toBe("grok");
    expect(cliVendorForProviderKind("langchain", "anthropic")).toBe("claude");
    expect(cliVendorForProviderKind("langchain", "ollama")).toBeUndefined();
    expect(cliVendorForProviderKind("cli", "codex")).toBe("codex");
  });

  it("resolves default binaries and API key env names", () => {
    expect(defaultBinaryFor("cursor")).toBe("cursor-agent");
    expect(apiKeyEnvForProviderKind("claude")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvForProviderKind("cursor")).toBe("CURSOR_API_KEY");
    expect(apiKeyEnvForProviderKind("langchain", "openai")).toBe("OPENAI_API_KEY");
    expect(hasApiKey("OPENAI_API_KEY", { OPENAI_API_KEY: "sk-x" })).toBe(true);
    expect(hasApiKey("OPENAI_API_KEY", { OPENAI_API_KEY: "  " })).toBe(false);
    expect(hasApiKey(undefined)).toBe(false);
  });

  it("detectLocalCli uses injected detectFn", async () => {
    const ok = await detectLocalCli("claude", { detectFn: async () => true });
    expect(ok).toEqual({ ok: true, binary: "claude" });
    const miss = await detectLocalCli("cursor", { detectFn: async () => false });
    expect(miss).toEqual({ ok: false, binary: "cursor-agent" });
  });

  it("detectLocalCli prefers cursor-agent over agent when both exist", async () => {
    const detectFn = async (binary: string) => binary === "cursor-agent" || binary === "agent";
    const hit = await detectLocalCli("cursor", { detectFn });
    expect(hit).toEqual({ ok: true, binary: "cursor-agent" });
  });

  it("detectLocalCli rejects bare agent when it is Grok Build", async () => {
    const hit = await detectLocalCli("cursor", {
      detectFn: async (binary) => binary === "agent",
      helpFn: async () => "Grok Build TUI\nUsage: agent [OPTIONS]",
    });
    expect(hit).toEqual({ ok: false, binary: "cursor-agent" });
  });

  it("detectLocalCli accepts bare agent when help fingerprints as Cursor", async () => {
    const hit = await detectLocalCli("cursor", {
      detectFn: async (binary) => binary === "agent",
      helpFn: async () => "Usage: agent [options]\n\nStart the Cursor Agent",
    });
    expect(hit).toEqual({ ok: true, binary: "agent" });
  });
});

describe("createCliProvider", () => {
  it("throws when binary is missing", async () => {
    const provider = createCliProvider({
      name: "local-claude",
      vendor: "claude",
      detectFn: async () => false,
    });
    await expect(
      provider.run({ prompt: "hi", tools: [], permission: "auto" }, fakeCtx()),
    ).rejects.toThrow(/not found on PATH/);
  });

  it("shells out and returns stdout as output", async () => {
    const execFileFn = vi.fn(async () => ({ stdout: '{"result":"hello from claude"}', stderr: "" }));
    const provider = createCliProvider({
      name: "local-claude",
      vendor: "claude",
      detectFn: async () => true,
      execFileFn: execFileFn as never,
    });
    const ctx = fakeCtx();
    const result = await provider.run({ prompt: "say hi", tools: [], permission: "auto" }, ctx);
    expect(result.stopReason).toBe("done");
    expect(result.output).toBe("hello from claude");
    expect(execFileFn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["-p", "say hi", "--output-format", "json"]),
      expect.objectContaining({ cwd: "/tmp/ws" }),
    );
  });

  it("builds codex exec args", async () => {
    const execFileFn = vi.fn(async () => ({ stdout: "ok", stderr: "" }));
    const provider = createCliProvider({
      name: "local-codex",
      vendor: "codex",
      model: "gpt-5",
      detectFn: async () => true,
      execFileFn: execFileFn as never,
    });
    await provider.run({ prompt: "build it", tools: [], permission: "auto" }, fakeCtx());
    expect(execFileFn).toHaveBeenCalledWith(
      "codex",
      ["exec", "build it", "-m", "gpt-5"],
      expect.any(Object),
    );
  });
});
