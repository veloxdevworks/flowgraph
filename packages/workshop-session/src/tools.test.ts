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

describe("applyFacilitatorTool finish", () => {
  const schema = {
    type: "object",
    properties: { title: { type: "string" }, risks: { type: "array" } },
    required: ["title"],
  };
  const finish = (reason?: string) => ({
    name: "finish",
    callId: "f",
    args: reason ? { reason } : {},
  });
  const fresh = () => ({ draft: {} as Record<string, unknown>, coverage: {} as Record<string, boolean | string> }) as {
    draft: Record<string, unknown>;
    coverage: Record<string, boolean | string>;
    endedReason?: string;
  };

  it("keeps the session open and names what is missing", () => {
    const state = fresh();
    const r = applyFacilitatorTool(state, finish(), { schema });
    expect(r.ok).toBe(false);
    expect(r.finish).toBeUndefined();
    expect(JSON.stringify(r.result)).toContain("title");
    expect(state.endedReason).toBeUndefined();
  });

  it("does not let the model skip the check by naming another reason", () => {
    for (const reason of ["human_ended", "timeout", "skipped"]) {
      expect(applyFacilitatorTool(fresh(), finish(reason), { schema }).finish).toBeUndefined();
    }
  });

  it("finishes once the draft satisfies the schema", () => {
    const state = fresh();
    applyFacilitatorTool(state, { name: "update_draft", callId: "1", args: { patch: { title: "SSO" } } }, { schema });
    expect(applyFacilitatorTool(state, finish(), { schema }).finish).toBe(true);
    expect(state.endedReason).toBe("completed");
  });

  it("refuses a draft with a wrong type", () => {
    const state = fresh();
    state.draft = { title: "SSO", risks: "none" };
    expect(applyFacilitatorTool(state, finish(), { schema }).finish).toBeUndefined();
  });

  it("ends early with allowPartial, but not as completed", () => {
    expect(applyFacilitatorTool(fresh(), finish("human_ended"), { schema, allowPartial: true }).finish).toBe(true);
    expect(applyFacilitatorTool(fresh(), finish("completed"), { schema, allowPartial: true }).finish).toBeUndefined();
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
