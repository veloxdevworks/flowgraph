import { describe, it, expect } from "vitest";
import type { InterruptInfo } from "@veloxdevworks/flowgraph-core";
import {
  formatInterruptPrompt,
  parseInterruptAnswer,
  serializePendingInterrupts,
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

  it("parses choice by index or text", () => {
    const it = info({ id: "1", kind: "choice", choices: ["alpha", "beta"] });
    expect(parseInterruptAnswer(it, "2")).toEqual({ choice: "beta" });
    expect(parseInterruptAnswer(it, "alpha")).toEqual({ choice: "alpha" });
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
