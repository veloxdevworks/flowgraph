import { describe, expect, it } from "vitest";
import { mintEphemeralToken } from "./mint.js";

describe("mintEphemeralToken", () => {
  it("posts to xAI and reads client_secret.value", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String((init?.headers as Record<string, string>)?.Authorization)).toContain("test-key");
      return new Response(JSON.stringify({ client_secret: { value: "ephemeral" }, expires_at: 1_700_000_000 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const minted = await mintEphemeralToken({ apiKey: "test-key", fetchImpl });
    expect(minted.token).toBe("ephemeral");
    expect(minted.provider).toBe("xai");
    expect(minted.url).toContain("wss://api.x.ai/v1/realtime");
  });

  it("fails without an api key", async () => {
    await expect(mintEphemeralToken({ apiKey: "" })).rejects.toThrow(/Missing API key/);
  });
});
