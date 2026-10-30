import { describe, expect, it } from "vitest";
import { applyFacilitatorTool } from "./tools.js";
import { voiceProvider } from "./providers.js";
import { apiKeyEnvForVoice } from "./mint.js";

describe("applyFacilitatorTool", () => {
  it("merges draft, coverage, risks, and finish", () => {
    const state = { draft: {} as Record<string, unknown>, coverage: {} as Record<string, boolean | string> };
    applyFacilitatorTool(state, { name: "update_draft", callId: "1", args: { patch: { title: "SSO" } } });
    expect(state.draft.title).toBe("SSO");
    applyFacilitatorTool(state, { name: "cover_agenda_item", callId: "2", args: { id: "scope", notes: "ok" } });
    expect(state.coverage.scope).toBe("ok");
    applyFacilitatorTool(state, { name: "add_risk", callId: "3", args: { risk: "migration" } });
    expect(state.draft.risks).toEqual(["migration"]);
    const done = applyFacilitatorTool(state, { name: "finish", callId: "4", args: { reason: "completed" } });
    expect(done.finish).toBe(true);
    expect(state.endedReason).toBe("completed");
  });
});

describe("voiceProvider", () => {
  it("defaults to xai and maps openai", () => {
    expect(voiceProvider().id).toBe("xai");
    expect(voiceProvider("openai").mintUrl).toContain("openai.com");
    expect(apiKeyEnvForVoice("xai")).toBe("XAI_API_KEY");
    expect(apiKeyEnvForVoice("openai")).toBe("OPENAI_API_KEY");
  });
});
