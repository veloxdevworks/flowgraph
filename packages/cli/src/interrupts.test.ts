import { describe, it, expect } from "vitest";
import type { InterruptInfo } from "@flowgraph/core";
import {
  formatInterruptPrompt,
  parseInterruptAnswer,
  serializePendingInterrupts,
  combineInterruptAnswers,
} from "./interrupts.js";

function info(partial: Partial<InterruptInfo> & { id: string }): InterruptInfo {
  return {
    id: partial.id,
    ...(partial.reason !== undefined ? { reason: partial.reason } : {}),
    ...(partial.kind !== undefined ? { kind: partial.kind } : {}),
    ...(partial.choices !== undefined ? { choices: partial.choices } : {}),
    ...(partial.payload !== undefined ? { payload: partial.payload } : {}),
    ...(partial.validationError !== undefined
      ? { validationError: partial.validationError, attempt: partial.attempt ?? 1, maxAttempts: partial.maxAttempts ?? 3 }
      : {}),
    ...(partial.exhausted ? { exhausted: true } : {}),
  };
}

describe("formatInterruptPrompt", () => {
  it("formats approval prompts", () => {
    const prompt = formatInterruptPrompt(info({ id: "1", reason: "Approve write?" }));
    expect(prompt).toContain("Approve?");
  });

  it("formats question prompts", () => {
    const prompt = formatInterruptPrompt(
      info({ id: "1", reason: "Which repo?", kind: "question" }),
    );
    expect(prompt).toContain("Which repo?");
    expect(prompt).toContain("Your answer:");
  });

  it("formats choice prompts with numbered options", () => {
    const prompt = formatInterruptPrompt(
      info({
        id: "1",
        reason: "Pick one",
        kind: "choice",
        choices: ["alpha", "beta"],
      }),
    );
    expect(prompt).toContain("1. alpha");
    expect(prompt).toContain("2. beta");
  });

  it("formats form and review prompts", () => {
    const form = formatInterruptPrompt(
      info({
        id: "1",
        reason: "Fill in",
        kind: "form",
        payload: { data: { schema: { type: "object" } } },
      }),
    );
    expect(form).toContain("JSON Schema");
    const review = formatInterruptPrompt(
      info({
        id: "1",
        reason: "Review",
        kind: "review",
        payload: { data: { diffStat: "1 file changed", decision: ["approve", "request-changes"] } },
      }),
    );
    expect(review).toContain("1 file changed");
    expect(review).toContain("approve, request-changes");
  });

  it("formats workshop prompts with agenda and schema", () => {
    const prompt = formatInterruptPrompt(
      info({
        id: "1",
        reason: "Workshop the feature",
        kind: "workshop",
        payload: {
          data: {
            agenda: [{ id: "scope", title: "Scope" }, { id: "risks", title: "Risks" }],
            schema: { type: "object", required: ["title"] },
          },
        },
      }),
    );
    expect(prompt).toContain("Agenda:");
    expect(prompt).toContain("1. Scope");
    expect(prompt).toContain("JSON Schema");
    expect(prompt).toContain("Paste JSON");
  });
});

describe("parseInterruptAnswer", () => {
  it("parses approval yes/no", () => {
    expect(parseInterruptAnswer(info({ id: "1" }), "yes")).toEqual({ approved: true });
    expect(parseInterruptAnswer(info({ id: "1" }), "no")).toEqual({ approved: false });
  });

  it("parses question free text", () => {
    expect(
      parseInterruptAnswer(info({ id: "1", kind: "question" }), "my answer"),
    ).toEqual({ answer: "my answer" });
  });

  it("parses form JSON and review decisions", () => {
    expect(
      parseInterruptAnswer(info({ id: "1", kind: "form" }), '{"title":"Epic"}'),
    ).toEqual({ title: "Epic" });
    expect(parseInterruptAnswer(info({ id: "1", kind: "review" }), "approve")).toEqual({
      decision: "approve",
    });
    expect(parseInterruptAnswer(info({ id: "1", kind: "review" }), "no")).toEqual({
      decision: "request-changes",
    });
  });

  it("parses workshop JSON output", () => {
    expect(
      parseInterruptAnswer(
        info({ id: "1", kind: "workshop" }),
        '{"output":{"title":"SSO"},"endedReason":"completed"}',
      ),
    ).toEqual({ output: { title: "SSO" }, endedReason: "completed" });
    expect(parseInterruptAnswer(info({ id: "1", kind: "workshop" }), '{"title":"SSO"}')).toEqual({
      title: "SSO",
    });
  });
});

describe("combineInterruptAnswers", () => {
  it("returns the single parsed value for one interrupt", () => {
    expect(
      combineInterruptAnswers(
        [info({ id: "a", kind: "approval" })],
        [{ approved: true }],
      ),
    ).toEqual({ approved: true });
  });

  it("returns an id-keyed map for multiple interrupts", () => {
    expect(
      combineInterruptAnswers(
        [
          info({ id: "hash-a", kind: "approval" }),
          info({ id: "hash-b", kind: "question" }),
        ],
        [{ approved: true }, { answer: "x" }],
      ),
    ).toEqual({
      "hash-a": { approved: true },
      "hash-b": { answer: "x" },
    });
  });
});

describe("serializePendingInterrupts", () => {
  it("returns machine-readable pending interrupt list", () => {
    const out = serializePendingInterrupts("thread-1", [
      info({
        id: "int-1",
        reason: "Which project?",
        kind: "question",
      }),
    ]);
    expect(out.threadId).toBe("thread-1");
    expect(out.interrupts[0]).toMatchObject({
      id: "int-1",
      kind: "question",
      reason: "Which project?",
    });
  });
});

describe("re-prompt after a rejected answer", () => {
  it("prefixes the prompt with the validation error and attempt budget", () => {
    const prompt = formatInterruptPrompt(
      info({ id: "1", reason: "Fill in", kind: "form", validationError: "title: required", attempt: 1, maxAttempts: 3 }),
    );
    expect(prompt.split("\n")[0]).toBe("Previous answer rejected (attempt 1 of 3): title: required");
    expect(prompt).toContain("Paste JSON form values");
  });

  it("includes validation fields in the pending interrupt list", () => {
    const out = serializePendingInterrupts("t", [
      info({ id: "i", kind: "form", validationError: "bad", attempt: 3, maxAttempts: 3, exhausted: true }),
    ]);
    expect(out.interrupts[0]).toMatchObject({ validationError: "bad", attempt: 3, maxAttempts: 3, exhausted: true });
  });
});

describe("gate artifacts and selection", () => {
  const data = { artifactRefs: ["a/one.png", "a/two.png"], select: "one" };

  it("lists artifact paths and the selected hint for review, approval and choice gates", () => {
    const review = formatInterruptPrompt(
      info({ id: "1", reason: "Pick", kind: "review", payload: { data: { ...data, decision: ["approve"] } } }),
    );
    expect(review).toContain("Artifacts: a/one.png, a/two.png");
    expect(review).toContain('"selected"');
    expect(review).toContain('"decision"');

    const approval = formatInterruptPrompt(info({ id: "1", reason: "Ok?", kind: "approval", payload: { data } }));
    expect(approval).toContain("Artifacts: a/one.png, a/two.png");
    expect(approval).toContain('"approved"');

    const choice = formatInterruptPrompt(
      info({ id: "1", reason: "Which", kind: "choice", choices: ["x", "y"], payload: { data } }),
    );
    expect(choice).toContain("Artifacts: a/one.png, a/two.png");
    expect(choice).toContain('"choice"');
  });

  it("shows no selection hint without select", () => {
    const p = formatInterruptPrompt(
      info({ id: "1", kind: "review", payload: { data: { artifactRefs: ["a.png"] } } }),
    );
    expect(p).toContain("Artifacts: a.png");
    expect(p).not.toContain('"selected"');
  });

  it("passes JSON answers with selected through untouched in every closed-answer mode", () => {
    expect(
      parseInterruptAnswer(info({ id: "1", kind: "approval" }), '{"approved":true,"selected":"a/one.png"}'),
    ).toEqual({ approved: true, selected: "a/one.png" });
    expect(
      parseInterruptAnswer(info({ id: "1", kind: "choice", choices: ["x", "y"] }), '{"choice":"x","selected":["a.png"]}'),
    ).toEqual({ choice: "x", selected: ["a.png"] });
    expect(
      parseInterruptAnswer(info({ id: "1", kind: "review" }), '{"decision":"approve","selected":{"path":"a.png"}}'),
    ).toEqual({ decision: "approve", selected: { path: "a.png" } });
  });
});

describe("gate evidence and overrides", () => {
  const bad = { artifactRefs: ["e/final.png"], evidence: [{ nodeId: "prove", status: "failed", needsOverride: true }] };
  const good = { artifactRefs: ["e/final.png"], evidence: [{ nodeId: "prove", status: "passed", needsOverride: false }] };

  it("says how to override only when some evidence needs it", () => {
    for (const kind of ["approval", "review"] as const) {
      expect(formatInterruptPrompt(info({ id: "1", reason: "Ship?", kind, payload: { data: bad } }))).toContain(
        'approving needs an override: answer "override: <reason>"',
      );
      expect(formatInterruptPrompt(info({ id: "1", reason: "Ship?", kind, payload: { data: good } }))).not.toContain("override");
    }
  });

  it("turns override: <reason> into an approving answer with that reason", () => {
    expect(parseInterruptAnswer(info({ id: "1", kind: "approval", payload: { data: bad } }), "override: hotfix, checked by hand")).toEqual({
      approved: true,
      override: { reason: "hotfix, checked by hand" },
    });
    expect(parseInterruptAnswer(info({ id: "1", kind: "review", payload: { data: bad } }), "Override:  known outage ")).toEqual({
      decision: "approve",
      override: { reason: "known outage" },
    });
    // An empty reason goes to the engine as one, which re-prompts.
    expect(parseInterruptAnswer(info({ id: "1", kind: "approval", payload: { data: bad } }), "override:")).toEqual({
      approved: true,
      override: { reason: "" },
    });
  });

  it("means nothing special at a gate without evidence", () => {
    expect(parseInterruptAnswer(info({ id: "1", kind: "approval" }), "override: x")).toBe("override: x");
  });
});

describe("resume hint", () => {
  it("suggests an override only when the gate's evidence needs one", async () => {
    const { resumeExample } = await import("./commands.js");
    const bad = { data: { evidence: [{ nodeId: "p", needsOverride: true }] } };
    expect(resumeExample([info({ id: "1", kind: "approval" })])).toBe('{"approved":true}');
    expect(resumeExample([info({ id: "1", kind: "approval", payload: bad })])).toBe('{"approved":true,"override":{"reason":"<why>"}}');
    expect(resumeExample([info({ id: "1", kind: "review", payload: bad })])).toBe('{"decision":"approve","override":{"reason":"<why>"}}');
  });
});
