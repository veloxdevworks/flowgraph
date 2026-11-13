import { describe, it, expect } from "vitest";
import type { InterruptInfo } from "@flowgraph/core";
import { checkWorkshopOutput } from "@flowgraph/spec";
import type { FacilitatorModel } from "@flowgraph/workshop-session";
import {
  resolveWorkshopModel,
  runWorkshopInteractive,
  WorkshopAbortError,
  type WorkshopIO,
} from "./workshop-interactive.js";

const schema = {
  type: "object",
  properties: {
    title: { type: "string" },
    count: { type: "integer" },
    ratio: { type: "number" },
    urgent: { type: "boolean" },
    acceptance: { type: "array", items: { type: "string" } },
    weights: { type: "array", items: { type: "integer" } },
    owner: { type: "object" },
    level: { type: "string", enum: ["low", "high"] },
  },
  required: ["title", "count"],
};

function contractOf(extra: Record<string, unknown> = {}, sch: Record<string, unknown> = schema) {
  return {
    mode: "workshop",
    fallback: "form",
    agenda: [
      { id: "problem", title: "Problem", description: "What is broken?" },
      { id: "acceptance", title: "Acceptance" },
    ],
    schema: sch,
    requireCoverage: true,
    ...extra,
  };
}

function interrupt(data: Record<string, unknown>, extra: Partial<InterruptInfo> = {}): InterruptInfo {
  return { id: "i1", kind: "workshop", reason: "Intake workshop", payload: { data }, ...extra } as InterruptInfo;
}

function scripted(lines: string[]) {
  const queue = [...lines];
  const out: string[] = [];
  const prompts: string[] = [];
  const io: WorkshopIO = {
    write: (t) => void out.push(t),
    ask: async (p) => {
      prompts.push(p);
      return queue.length ? queue.shift()! : null;
    },
  };
  return { io, out, prompts, text: () => out.join("\n"), left: () => queue.length };
}

type Step = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> };
function fakeModel(steps: Step[]): FacilitatorModel & { calls: number } {
  let n = 0;
  const m = {
    calls: 0,
    async respond() {
      m.calls++;
      const s = steps[n++] ?? { text: "(no more script)" };
      return {
        ...(s.text ? { text: s.text } : {}),
        toolCalls: (s.toolCalls ?? []).map((c, i) => ({ id: `c${n}_${i}`, name: c.name, args: c.args })),
      };
    },
  };
  return m;
}

describe("resolveWorkshopModel", () => {
  it("is unset without the variable", () => {
    expect(resolveWorkshopModel({})).toEqual({ status: "unset" });
    expect(resolveWorkshopModel({ FLOWGRAPH_WORKSHOP_MODEL: "  " })).toEqual({ status: "unset" });
  });

  it("parses anthropic, openai and xai", () => {
    expect(resolveWorkshopModel({ FLOWGRAPH_WORKSHOP_MODEL: "anthropic:m-1", ANTHROPIC_API_KEY: "k1" })).toEqual({
      status: "ok",
      config: { vendor: "anthropic", model: "m-1", apiKey: "k1" },
    });
    expect(resolveWorkshopModel({ FLOWGRAPH_WORKSHOP_MODEL: "openai:gpt-x:y", OPENAI_API_KEY: "k2" })).toEqual({
      status: "ok",
      config: { vendor: "openai", model: "gpt-x:y", apiKey: "k2" },
    });
    expect(resolveWorkshopModel({ FLOWGRAPH_WORKSHOP_MODEL: "xai:grok-z", XAI_API_KEY: "k3", GROK_API_KEY: "g" })).toEqual({
      status: "ok",
      config: { vendor: "xai", model: "grok-z", apiKey: "k3", baseUrl: "https://api.x.ai/v1" },
    });
  });

  it("xai falls back to GROK_API_KEY", () => {
    const r = resolveWorkshopModel({ FLOWGRAPH_WORKSHOP_MODEL: "xai:grok-z", GROK_API_KEY: "g" });
    expect(r).toMatchObject({ status: "ok", config: { apiKey: "g" } });
  });

  it("rejects bad values without leaking keys", () => {
    for (const v of ["nocolon", "anthropic:", "mistral:large", ":model"]) {
      const r = resolveWorkshopModel({ FLOWGRAPH_WORKSHOP_MODEL: v, ANTHROPIC_API_KEY: "SECRET-KEY" });
      expect(r.status).toBe("invalid");
      expect(JSON.stringify(r)).not.toContain("SECRET-KEY");
    }
    const noKey = resolveWorkshopModel({ FLOWGRAPH_WORKSHOP_MODEL: "openai:gpt" });
    expect(noKey).toMatchObject({ status: "invalid" });
    expect((noKey as { error: string }).error).toContain("OPENAI_API_KEY");
  });
});

describe("mode selection", () => {
  it("defaults to form without a model, and shows the validation error first", async () => {
    const s = scripted(["", "", "", "T", "3", "", "", "", "", "", ""]);
    const it = interrupt(contractOf(), { validationError: "draft: missing required field(s): title", attempt: 2, maxAttempts: 3 });
    const resume = (await runWorkshopInteractive(it, { io: s.io, env: {} })) as { endedReason: string };
    expect(resume.endedReason).toBe("completed");
    expect(s.out[1]).toContain("Previous answer rejected (attempt 2 of 3)");
    expect(s.prompts[0]).toBe("Choose [form]: ");
    expect(s.text()).not.toContain("chat ");
  });

  it("defaults to json when contract.fallback is json and no model is configured", async () => {
    const s = scripted(["", '{"output":{"title":"x","count":1}}']);
    const resume = await runWorkshopInteractive(interrupt(contractOf({ fallback: "json" })), { io: s.io, env: {} });
    expect(s.prompts[0]).toBe("Choose [json]: ");
    expect(resume).toEqual({ output: { title: "x", count: 1 } });
  });

  it("json keeps today's lenient parsing", async () => {
    const s = scripted(["json", "just some words"]);
    const resume = await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, env: {} });
    expect(resume).toEqual({ output: { notes: "just some words" } });
  });

  it("refuses chat when no model is configured and explains why", async () => {
    const s = scripted(["chat", "json", "{}"]);
    await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, env: {} });
    expect(s.text()).toContain("Chat is not available");
  });

  it("reports an invalid FLOWGRAPH_WORKSHOP_MODEL and falls back to the form default", async () => {
    const s = scripted(["json", "{}"]);
    await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, env: { FLOWGRAPH_WORKSHOP_MODEL: "bogus" } });
    expect(s.text()).toContain("FLOWGRAPH_WORKSHOP_MODEL: 'bogus' has no ':'");
    expect(s.prompts[0]).toBe("Choose [form]: ");
  });

  it("defaults to chat when a model is configured", async () => {
    const s = scripted([""]);
    const model = fakeModel([{ text: "Hello!" }]);
    // EOF right after the greeting: nothing allows ending, so the prompt aborts
    await expect(runWorkshopInteractive(interrupt(contractOf()), { io: s.io, model })).rejects.toBeInstanceOf(
      WorkshopAbortError,
    );
    expect(s.prompts[0]).toBe("Choose [chat]: ");
    expect(s.text()).toContain("Hello!");
  });

  it("aborts when input ends at the menu", async () => {
    await expect(runWorkshopInteractive(interrupt(contractOf()), { io: scripted([]).io, env: {} })).rejects.toBeInstanceOf(
      WorkshopAbortError,
    );
  });
});

describe("chat", () => {
  const steps: Step[] = [
    { text: "Welcome. What problem are we solving?" },
    {
      toolCalls: [
        { name: "update_draft", args: { patch: { title: "SSO login", count: 2 } } },
        { name: "cover_agenda_item", args: { id: "problem" } },
        { name: "cover_agenda_item", args: { id: "acceptance", notes: "two criteria" } },
      ],
    },
    { text: "Got it. Anything else?" },
    { toolCalls: [{ name: "finish", args: { reason: "completed" } }] },
  ];

  it("runs a scripted session to an accepted finish", async () => {
    const s = scripted(["", "Admin login is broken. SSO please.", "no that is all"]);
    const model = fakeModel(steps);
    const resume = (await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, model })) as {
      output: Record<string, unknown>;
      endedReason: string;
      coverage: Record<string, unknown>;
      transcript: Array<{ role: string; text: string }>;
    };
    expect(resume.endedReason).toBe("completed");
    expect(resume.output).toEqual({ title: "SSO login", count: 2 });
    expect(resume.coverage).toEqual({ problem: true, acceptance: "two criteria" });
    expect(resume.transcript.filter((t) => t.role === "user").map((t) => t.text)).toEqual([
      "Admin login is broken. SSO please.",
      "no that is all",
    ]);
    // the value the engine would validate
    const c = contractOf();
    expect(
      checkWorkshopOutput(resume.output, {
        schema: c.schema,
        endedReason: resume.endedReason,
        requireCoverage: true,
        agenda: c.agenda,
        coverage: resume.coverage,
      }).complete,
    ).toBe(true);
    // compact agenda marks with coverage are printed after each turn
    expect(s.text()).toContain("[ ] problem  [ ] acceptance");
    expect(s.text()).toContain("[x] problem  [x] acceptance");
    expect(s.text()).toContain("ready to finish");
  });

  it("/status and /draft print state; unknown commands print help", async () => {
    const s = scripted(["chat", "hello", "/status", "/draft", "/wat"]);
    const model = fakeModel([
      { text: "hi" },
      { toolCalls: [{ name: "set_field", args: { path: "title", value: "T" } }] },
      { text: "noted" },
    ]);
    await expect(runWorkshopInteractive(interrupt(contractOf()), { io: s.io, model })).rejects.toBeInstanceOf(
      WorkshopAbortError,
    );
    expect(s.text()).toContain("missing: count");
    expect(s.text()).toContain('"title": "T"');
    expect(s.text()).toContain("Commands: /status");
  });

  it("/end is refused when the rule does not allow it, and the session stays open", async () => {
    const s = scripted(["chat", "/end", "/status"]);
    const model = fakeModel([{ text: "hi" }]);
    await expect(runWorkshopInteractive(interrupt(contractOf()), { io: s.io, model })).rejects.toBeInstanceOf(
      WorkshopAbortError,
    );
    expect(s.text()).toContain("Cannot end yet: draft: missing required field(s)");
    expect(s.left()).toBe(0); // /status after /end was still read
  });

  it("/end is accepted with allowPartial", async () => {
    const s = scripted(["chat", "/end"]);
    const model = fakeModel([{ text: "hi" }]);
    const resume = (await runWorkshopInteractive(interrupt(contractOf({ allowPartial: true })), { io: s.io, model })) as {
      endedReason: string;
    };
    expect(resume.endedReason).toBe("human_ended");
  });

  it("EOF ends as human_ended with allowPartial, aborts otherwise", async () => {
    const model = () => fakeModel([{ text: "hi" }]);
    const ok = (await runWorkshopInteractive(interrupt(contractOf({ allowPartial: true })), {
      io: scripted(["chat"]).io,
      model: model(),
    })) as { endedReason: string };
    expect(ok.endedReason).toBe("human_ended");
    await expect(
      runWorkshopInteractive(interrupt(contractOf()), { io: scripted(["chat"]).io, model: model() }),
    ).rejects.toBeInstanceOf(WorkshopAbortError);
  });

  it("a finish the rule rejects keeps the session open", async () => {
    const s = scripted(["chat", "done?", "/end"]);
    const model = fakeModel([
      { text: "hi" },
      { toolCalls: [{ name: "finish", args: { reason: "completed" } }] },
      { text: "Not yet: I still need a title." },
    ]);
    const resume = (await runWorkshopInteractive(interrupt(contractOf({ allowPartial: true })), { io: s.io, model })) as {
      endedReason: string;
    };
    expect(s.text()).toContain("Not yet: I still need a title.");
    expect(resume.endedReason).toBe("human_ended");
  });

  it("/json takes a pasted resume", async () => {
    const s = scripted(["chat", "/json", '{"output":{"title":"p","count":1},"endedReason":"completed"}']);
    const resume = await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, model: fakeModel([{ text: "hi" }]) });
    expect(resume).toEqual({ output: { title: "p", count: 1 }, endedReason: "completed" });
  });

  it("/form carries the draft and coverage over", async () => {
    // after /form: agenda "acceptance" asked (problem already covered), title kept, count asked, rest skipped
    const s = scripted(["chat", "start", "/form", "", "", "7", "", "", "", "", "", ""]);
    const model = fakeModel([
      { text: "hi" },
      {
        toolCalls: [
          { name: "set_field", args: { path: "title", value: "Carried" } },
          { name: "cover_agenda_item", args: { id: "problem" } },
        ],
      },
      { text: "ok" },
    ]);
    const resume = (await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, model })) as {
      output: Record<string, unknown>;
      coverage: Record<string, unknown>;
    };
    expect(s.text()).toContain("Problem: already covered");
    expect(resume.output).toEqual({ title: "Carried", count: 7 });
    expect(resume.coverage).toEqual({ problem: true, acceptance: true });
  });

  it("a model failure is reported and the chat continues", async () => {
    const s = scripted(["chat", "hello", "/end"]);
    let n = 0;
    const model: FacilitatorModel = {
      async respond() {
        if (n++ === 1) throw new Error("boom 500");
        return { text: "fine", toolCalls: [] };
      },
    };
    await runWorkshopInteractive(interrupt(contractOf({ allowPartial: true })), { io: s.io, model });
    expect(s.text()).toContain("Facilitator error: boom 500");
  });
});

describe("form", () => {
  it("parses by declared type, skips optional fields, and ends completed", async () => {
    const s = scripted([
      "form",
      "", // problem: confirm
      "needs a note", // acceptance: annotate
      "My title", // title
      "abc", // count: invalid
      "4.5", // count: not an integer
      "4", // count
      "0.25", // ratio
      "yes", // urgent
      "login works", // acceptance (array): items...
      "logout works",
      "", // end of list
      "1", // weights
      "x", // bad integer item
      "3",
      "",
      '{"name":"Ada"}', // owner
      "", // level skipped
    ]);
    const resume = (await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, env: {} })) as {
      output: Record<string, unknown>;
      coverage: Record<string, unknown>;
      endedReason: string;
    };
    expect(resume.output).toEqual({
      title: "My title",
      count: 4,
      ratio: 0.25,
      urgent: true,
      acceptance: ["login works", "logout works"],
      weights: [1, 3],
      owner: { name: "Ada" },
    });
    expect(resume.coverage).toEqual({ problem: true, acceptance: "needs a note" });
    expect(resume.endedReason).toBe("completed");
    expect(s.text()).toContain("'abc' is not a number");
    expect(s.text()).toContain("'4.5' is not an integer");
    expect(s.text()).toContain("count (integer, required)");
    expect(s.text()).toContain("level (string, one of:");
  });

  it("accepts a JSON array and re-asks a required field left blank", async () => {
    const s = scripted(["form", "", "", "", "T", "1", "", "", '["a","b"]', "", "", ""]);
    // blank title -> "required", then T
    const resume = (await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, env: {} })) as {
      output: Record<string, unknown>;
    };
    expect(s.text()).toContain("This field is required.");
    expect(resume.output).toEqual({ title: "T", count: 1, acceptance: ["a", "b"] });
  });

  it("re-prompts only the failing field after the rule rejects", async () => {
    // the chat left a bad value in the draft; the form keeps it on Enter, so the rule rejects it
    const s = scripted([
      "chat", "go", "/form",
      "", "", // agenda
      "", "", "", "", "", "", "", "", // keep title and count, skip the rest
      "", // re-prompt of count: blank is not accepted now
      "abc", // still not a number
      "5",
    ]);
    const model = fakeModel([
      { text: "hi" },
      { toolCalls: [{ name: "update_draft", args: { patch: { title: "T", count: "two" } } }] },
      { text: "ok" },
    ]);
    const resume = (await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, model })) as {
      output: Record<string, unknown>;
    };
    expect(s.text()).toContain('Not accepted: draft: field "count" expected type integer.');
    expect(s.text()).toContain("The current value was rejected; enter a new one.");
    expect(resume.output).toEqual({ title: "T", count: 5 });
    expect(s.prompts.filter((p) => p === "count> ")).toHaveLength(4);
    expect(s.prompts.filter((p) => p === "title> ")).toHaveLength(1);
  });

  it("re-asks skipped agenda items when coverage is required", async () => {
    const s = scripted(["form", "skip", "", "T", "1", "", "", "", "", "", "", "yes covered"]);
    const resume = (await runWorkshopInteractive(interrupt(contractOf()), { io: s.io, env: {} })) as {
      coverage: Record<string, unknown>;
    };
    expect(s.text()).toContain("agenda item(s) not covered: problem");
    expect(resume.coverage["problem"]).toBe("yes covered");
  });

  it("with allowPartial offers to end early after a rejection", async () => {
    const s = scripted(["form", "skip", "", "T", "1", "", "", "", "", "", "", "end"]);
    const resume = (await runWorkshopInteractive(interrupt(contractOf({ allowPartial: true })), { io: s.io, env: {} })) as {
      endedReason: string;
      output: Record<string, unknown>;
    };
    expect(resume.endedReason).toBe("human_ended");
    expect(resume.output["title"]).toBe("T");
  });

  it("EOF mid-form ends as human_ended with allowPartial, aborts otherwise", async () => {
    const ok = (await runWorkshopInteractive(interrupt(contractOf({ allowPartial: true })), {
      io: scripted(["form", "", "", "T"]).io,
      env: {},
    })) as { endedReason: string; output: Record<string, unknown> };
    expect(ok.endedReason).toBe("human_ended");
    expect(ok.output).toEqual({ title: "T" });
    await expect(
      runWorkshopInteractive(interrupt(contractOf()), { io: scripted(["form", "", "", "T"]).io, env: {} }),
    ).rejects.toBeInstanceOf(WorkshopAbortError);
  });
});
