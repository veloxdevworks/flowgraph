import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeProviderFromConfig } from "./factory.js";

describe("createClaudeProviderFromConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses an apiKeyEnv the graph does not declare", async () => {
    vi.stubEnv("FGQA_CLAUDE_FACTORY_KEY", "sk-claude");
    await expect(
      createClaudeProviderFromConfig("claude", { kind: "claude", apiKeyEnv: "FGQA_CLAUDE_FACTORY_KEY" }),
    ).rejects.toMatchObject({
      code: "SECRET_UNDECLARED",
      message: expect.stringContaining('Provider "claude" apiKeyEnv reads secret "FGQA_CLAUDE_FACTORY_KEY"'),
    });
  });

  it("reads a declared apiKeyEnv", async () => {
    vi.stubEnv("FGQA_CLAUDE_FACTORY_KEY", "sk-claude");
    const provider = await createClaudeProviderFromConfig(
      "claude",
      { kind: "claude", apiKeyEnv: "FGQA_CLAUDE_FACTORY_KEY" },
      { secrets: ["FGQA_CLAUDE_FACTORY_KEY"] },
    );
    expect(provider.name).toBe("claude");
  });
});
