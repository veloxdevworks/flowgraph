import { describe, it, expect } from "vitest";
import { isKnownLangChainVendor, LANGCHAIN_VENDORS } from "./factory.js";

describe("LangChain provider factory", () => {
  it("recognizes known LangChain vendors", () => {
    for (const v of LANGCHAIN_VENDORS) {
      expect(isKnownLangChainVendor(v)).toBe(true);
    }
    expect(isKnownLangChainVendor("unknown")).toBe(false);
  });

  it("createLangChainProviderFromConfig fails for unknown vendor", async () => {
    const { createLangChainProviderFromConfig } = await import("./factory.js");
    await expect(
      createLangChainProviderFromConfig("bad", {
        kind: "langchain",
        vendor: "not-a-vendor" as "openai",
      }),
    ).rejects.toThrow(/Unknown LangChain vendor/);
  });

  it("createLangChainProviderFromConfig fails when vendor package is missing", async () => {
    const { createLangChainProviderFromConfig } = await import("./factory.js");
    await expect(
      createLangChainProviderFromConfig("openai", {
        kind: "langchain",
        vendor: "openai",
        model: "gpt-4o",
      }),
    ).rejects.toThrow(/not installed|Missing API key/);
  });
});
