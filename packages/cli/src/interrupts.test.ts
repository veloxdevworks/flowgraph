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
