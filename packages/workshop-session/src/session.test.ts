import { describe, expect, it } from "vitest";
import { WorkshopSession } from "./session.js";

describe("WorkshopSession.buildInstructions", () => {
  it("includes agenda, schema, and facilitator prompt", () => {
    const session = new WorkshopSession(
      {
        token: "t",
        url: "wss://example",
        model: "grok-voice-latest",
        provider: "xai",
      },
      {
        agenda: [{ id: "scope", title: "Scope", description: "what we ship" }],
        schema: { type: "object", properties: { title: { type: "string" } } },
        facilitator: "Cover every item.",
        context: "SSO research",
      },
    );
    const text = session.buildInstructions("User: hello");
    expect(text).toContain("Cover every item.");
    expect(text).toContain("scope: Scope");
    expect(text).toContain("SSO research");
    expect(text).toContain("Prior transcript");
    expect(text).toContain("update_draft");
  });
});
