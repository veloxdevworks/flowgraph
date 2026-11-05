import { describe, expect, it } from "vitest";
import { checkWorkshopOutput } from "@flowgraph/spec";
import { WorkshopController } from "./controller.js";
import { TextFacilitator, type FacilitatorModel } from "./text-facilitator.js";
import type { WorkshopContract } from "./types.js";

const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
const contract = (extra: Partial<WorkshopContract> = {}): WorkshopContract => ({
  mode: "workshop",
  agenda: [{ id: "scope", title: "Scope" }],
  fallback: "text",
  schema,
  requireCoverage: true,
  ...extra,
});

type Reply = { text?: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] };
function scripted(replies: Reply[]) {
  const requests: Parameters<FacilitatorModel["respond"]>[0][] = [];
  let i = 0;
  const model: FacilitatorModel = {
    async respond(req) {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      const r = replies[i++] ?? { text: "(script exhausted)" };
      return { ...(r.text !== undefined ? { text: r.text } : {}), toolCalls: r.toolCalls ?? [] };
    },
  };
  return { model, requests };
}

describe("TextFacilitator", () => {
  it("runs a workshop end to end through a multi-step tool loop", async () => {
    const c = new WorkshopController(contract());
    const { model, requests } = scripted([
      { text: "Welcome! What are we building?" },
      {
        text: "Got it.",
        toolCalls: [
          { id: "1", name: "set_field", args: { path: "title", value: "SSO" } },
          { id: "2", name: "cover_agenda_item", args: { id: "scope" } },
        ],
      },
      { toolCalls: [{ id: "3", name: "finish", args: {} }] },
    ]);
    const f = new TextFacilitator(c, model);
    const opening = await f.start();
    expect(opening).toEqual({ reply: "Welcome! What are we building?", ended: false });
    const r = await f.send("single sign-on for the admin console");
    expect(r).toEqual({ reply: "Got it.", ended: true });
    expect(c.ended).toBe(true);
    expect(requests).toHaveLength(3);
    // tool results flow back to the model
    const third = requests[2]!.messages;
    expect(third.at(-1)).toMatchObject({ role: "tool", toolCallId: "2" });
    expect(JSON.parse((third.at(-2) as any).content).status).toBeDefined();
    expect(requests[0]!.tools.map((t) => t.name)).toContain("finish");
    expect(requests[0]!.system).toContain("Agenda:");
    const resume = c.toResume();
    expect(checkWorkshopOutput(resume.output, { schema, endedReason: resume.endedReason, requireCoverage: true, agenda: c.contract.agenda, coverage: resume.coverage }).complete).toBe(true);
    expect(resume.transcript.map((t) => t.role)).toEqual(["assistant", "user", "assistant"]);
    await expect(f.send("more")).rejects.toThrow(/ended/);
  });

  it("keeps the session open when finish is refused and tells the model why", async () => {
    const c = new WorkshopController(contract());
    const { model, requests } = scripted([
      { toolCalls: [{ id: "1", name: "finish", args: {} }] },
      { text: "What is the title?" },
    ]);
    const f = new TextFacilitator(c, model);
    const r = await f.send("we're done");
    expect(r).toEqual({ reply: "What is the title?", ended: false });
    const toolMsg = requests[1]!.messages.at(-1) as any;
    expect(JSON.parse(toolMsg.content)).toMatchObject({ ok: false, status: { missing: ["title"] } });
  });

  it("stops at the step cap", async () => {
    const c = new WorkshopController(contract());
    const loop: Reply = { toolCalls: [{ id: "x", name: "update_draft", args: { patch: {} } }] };
    const { model, requests } = scripted([loop, loop, loop, loop, loop]);
    const r = await new TextFacilitator(c, model, { maxSteps: 3 }).send("hi");
    expect(requests).toHaveLength(3);
    expect(r).toMatchObject({ ended: false, stepLimitReached: true });
  });

  it("is abortable", async () => {
    const c = new WorkshopController(contract());
    const ac = new AbortController();
    const model: FacilitatorModel = {
      async respond({ signal }) {
        ac.abort();
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        return { toolCalls: [] };
      },
    };
    await expect(new TextFacilitator(c, model).send("hi", { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    const pre = new AbortController();
    pre.abort();
    await expect(new TextFacilitator(c, scripted([]).model).send("hi", { signal: pre.signal })).rejects.toThrow();
  });

  it("rebuilds history from the transcript after restore and resumes", async () => {
    const c = new WorkshopController(contract());
    const first = new TextFacilitator(c, scripted([{ text: "Hello" }, { text: "Tell me more" }]).model);
    await first.start();
    await first.send("about SSO");
    const restored = WorkshopController.restore(contract(), JSON.parse(JSON.stringify(c.snapshot())));
    const { model, requests } = scripted([{ text: "Welcome back" }]);
    const f = new TextFacilitator(restored, model);
    expect(f.history.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    const r = await f.start();
    expect(r.reply).toBe("Welcome back");
    expect(requests[0]!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(requests[0]!.system).toContain("Session in progress");
  });

  it("serves read_artifact only when a reader is provided", async () => {
    const c = new WorkshopController(contract());
    const { model, requests } = scripted([
      { toolCalls: [{ id: "r", name: "read_artifact", args: { path: "a.md" } }] },
      { text: "ok" },
    ]);
    await new TextFacilitator(c, model, { readArtifact: (p) => `contents of ${p}` }).send("look");
    expect(requests[0]!.tools.map((t) => t.name)).toContain("read_artifact");
    expect((requests[1]!.messages.at(-1) as any).content).toContain("contents of a.md");
    const none = scripted([{ text: "x" }]);
    await new TextFacilitator(new WorkshopController(contract()), none.model).send("hi");
    expect(none.requests[0]!.tools.map((t) => t.name)).not.toContain("read_artifact");
  });
});
