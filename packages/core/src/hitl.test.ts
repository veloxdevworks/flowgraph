import { describe, it, expect } from "vitest";
import { compileGraph } from "./compiler.js";
import { mockProvider } from "./providers/index.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

function hitlGraph(
  mode: "approve" | "question" | "choice",
  extra: Record<string, unknown> = {},
): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "hitl-graph" },
    state: { channels: { gateResult: { type: "object" } } },
    nodes: [
      {
        id: "human-gate",
        type: "hitl",
        with: {
          mode,
          message: "Please respond",
          ...(mode === "choice" ? { choices: ["a", "b"] } : {}),
          output: { to: "gateResult" },
          ...extra,
        },
      },
    ],
    edges: [
      { from: "START", to: "human-gate" },
      { from: "human-gate", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("hitl node", () => {
  it("approve mode interrupts with kind approval and maps resume to approved", async () => {
    const compiled = await compileGraph(hitlGraph("approve"), {});
    const r1 = await compiled.run({ threadId: "hitl-approve", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.kind).toBe("approval");

    const r2 = await compiled.resume({
      threadId: "hitl-approve",
      resume: { approved: true },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect((r2.state["gateResult"] as { approved: boolean }).approved).toBe(true);
  });

  it("question mode interrupts with kind question and maps resume to answer", async () => {
    const compiled = await compileGraph(hitlGraph("question"), {});
    const r1 = await compiled.run({ threadId: "hitl-q", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.kind).toBe("question");

    const r2 = await compiled.resume({
      threadId: "hitl-q",
      resume: { answer: "clarified" },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect((r2.state["gateResult"] as { answer: string }).answer).toBe("clarified");
  });

  it("choice mode interrupts with kind choice and maps resume to choice", async () => {
    const compiled = await compileGraph(hitlGraph("choice"), {});
    const r1 = await compiled.run({ threadId: "hitl-c", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.kind).toBe("choice");
    expect(r1.interrupts?.[0]?.choices).toEqual(["a", "b"]);

    const r2 = await compiled.resume({
      threadId: "hitl-c",
      resume: { choice: "b" },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect((r2.state["gateResult"] as { choice: string }).choice).toBe("b");
  });
});

describe("ask_human tool", () => {
  it("interrupts with kind question and resumes with an answer", async () => {
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "ask-human" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [
        {
          id: "agent",
          type: "agent",
          provider: "mock",
          with: {
            prompt: "Need clarification",
            tools: [{ function: "ask_human" }],
            output: { to: "answer" },
          },
        },
      ],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, { providers: [mockProvider] });
    const r1 = await compiled.run({ threadId: "ask-t1", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.kind).toBe("question");

    const r2 = await compiled.resume({
      threadId: "ask-t1",
      resume: { answer: "use option B" },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    const out = r2.state["answer"] as { toolResults: Record<string, { answer: string }> };
    expect(out.toolResults["ask_human"]?.answer).toBe("use option B");
  });
});
