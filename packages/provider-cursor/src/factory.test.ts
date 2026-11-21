import { afterEach, describe, expect, it, vi } from "vitest";
import { createCursorProviderFromConfig } from "./factory.js";

describe("createCursorProviderFromConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses an apiKeyEnv the graph does not declare", async () => {
    vi.stubEnv("FGQA_CURSOR_FACTORY_KEY", "crsr-key");
    await expect(
      createCursorProviderFromConfig("cursor", { kind: "cursor", apiKeyEnv: "FGQA_CURSOR_FACTORY_KEY" }),
    ).rejects.toMatchObject({
      code: "SECRET_UNDECLARED",
      message: expect.stringContaining('Provider "cursor" apiKeyEnv reads secret "FGQA_CURSOR_FACTORY_KEY"'),
    });
  });

  it("reads a declared apiKeyEnv", async () => {
    vi.stubEnv("FGQA_CURSOR_FACTORY_KEY", "crsr-key");
    const provider = await createCursorProviderFromConfig(
      "cursor",
      { kind: "cursor", apiKeyEnv: "FGQA_CURSOR_FACTORY_KEY" },
      { secrets: ["FGQA_CURSOR_FACTORY_KEY"] },
    );
    expect(provider.name).toBe("cursor");
  });
});
