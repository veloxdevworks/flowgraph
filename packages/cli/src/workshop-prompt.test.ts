import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { InterruptInfo } from "@flowgraph/core";

const state = vi.hoisted(() => ({ questions: [] as string[], answers: [] as string[], lines: [] as string[] }));

vi.mock("node:readline/promises", () => ({
  createInterface: () => {
    const rl = new EventEmitter() as EventEmitter & Record<string, unknown>;
    rl["question"] = async (q: string) => {
      state.questions.push(q);
      return state.answers.shift() ?? "";
    };
    rl["setPrompt"] = () => {};
    rl["prompt"] = () => {
      const next = state.lines.shift();
      setImmediate(() => (next === undefined ? rl.emit("close") : rl.emit("line", next)));
    };
    rl["close"] = () => {};
    return rl;
  },
}));

import { promptResolver } from "./interrupts.js";

const workshop = {
  id: "w1",
  kind: "workshop",
  reason: "Intake",
  payload: {
    data: {
      mode: "workshop",
      fallback: "form",
      agenda: [{ id: "a", title: "A" }],
      schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    },
  },
} as InterruptInfo;

function setTTY(v: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
}

describe("promptResolver with workshop interrupts", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    state.questions = [];
    state.answers = [];
    state.lines = [];
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    setTTY(false);
    delete (process.stdin as { isTTY?: boolean }).isTTY;
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  });

  it("non-TTY keeps the paste-JSON prompt exactly", async () => {
    setTTY(false);
    state.answers = ['{"output":{"title":"x"}}'];
    const resume = await promptResolver([workshop]);
    expect(resume).toEqual({ output: { title: "x" } });
    expect(state.questions).toHaveLength(1);
    expect(state.questions[0]).toContain('Paste JSON { "output", "transcript?", "coverage?", "endedReason?" }');
    expect(state.questions[0]).not.toContain("How do you want");
  });

  it("TTY runs the interactive session (form) over readline", async () => {
    setTTY(true);
    process.env["FLOWGRAPH_WORKSHOP_MODEL"] = "";
    state.lines = ["form", "", "Hello"];
    const resume = (await promptResolver([workshop])) as { output: unknown; endedReason: string };
    expect(resume.output).toEqual({ title: "Hello" });
    expect(resume.endedReason).toBe("completed");
    expect(state.questions).toHaveLength(0);
  });

  it("non-workshop interrupts on a TTY still use rl.question", async () => {
    setTTY(true);
    state.answers = ["yes"];
    const resume = await promptResolver([{ id: "x", reason: "ok?" } as InterruptInfo]);
    expect(resume).toEqual({ approved: true });
    expect(state.questions).toHaveLength(1);
  });
});
