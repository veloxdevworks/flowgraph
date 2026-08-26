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

  it("approve mode accepts a bare boolean resume", async () => {
    const compiled = await compileGraph(hitlGraph("approve"), {});
    await compiled.run({ threadId: "hitl-bool", onInterrupt: "fail" });
    const r2 = await compiled.resume({
      threadId: "hitl-bool",
      resume: true,
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect((r2.state["gateResult"] as { approved: boolean }).approved).toBe(true);
  });

  it("choice mode maps a 1-based index to the choice string", async () => {
    const compiled = await compileGraph(hitlGraph("choice"), {});
    await compiled.run({ threadId: "hitl-idx", onInterrupt: "fail" });
    const r2 = await compiled.resume({
      threadId: "hitl-idx",
      resume: "2",
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect((r2.state["gateResult"] as { choice: string }).choice).toBe("b");
  });

  it("choice mode rejects an invalid choice", async () => {
    const compiled = await compileGraph(hitlGraph("choice"), {});
    await compiled.run({ threadId: "hitl-bad", onInterrupt: "fail" });
    const r2 = await compiled.resume({
      threadId: "hitl-bad",
      resume: { choice: "nope" },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("error");
    expect(r2.error?.message).toContain("Invalid choice");
  });
});

function parallelHitlSpec(): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "parallel-hitl" },
    state: {
      channels: {
        gateA: { type: "object" },
        gateB: { type: "object" },
      },
    },
    nodes: [
      {
        id: "gate-a",
        type: "hitl",
        with: { mode: "approve", message: "Approve A?", output: { to: "gateA" } },
      },
      {
        id: "gate-b",
        type: "hitl",
        with: { mode: "question", message: "Answer B?", output: { to: "gateB" } },
      },
    ],
    edges: [
      { from: "START", to: ["gate-a", "gate-b"] },
      { from: "gate-a", to: "END" },
      { from: "gate-b", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("parallel HITL interrupts", () => {
  it("resumes both pending interrupts via an id-keyed map", async () => {
    const compiled = await compileGraph(parallelHitlSpec(), {});
    const r1 = await compiled.run({ threadId: "hitl-par", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts).toHaveLength(2);

    const byNode = new Map(
      (r1.interrupts ?? []).map((it) => {
        const data = (it.payload as { data?: { __nodeId?: string } } | undefined)?.data;
        return [data?.__nodeId ?? it.id, it];
      }),
    );
    const a = byNode.get("gate-a");
    const b = byNode.get("gate-b");
    expect(a?.kind).toBe("approval");
    expect(b?.kind).toBe("question");

    const r2 = await compiled.resume({
      threadId: "hitl-par",
      resume: {
        [a!.id]: { approved: true },
        [b!.id]: { answer: "clarified" },
      },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect((r2.state["gateA"] as { approved: boolean }).approved).toBe(true);
    expect((r2.state["gateB"] as { answer: string }).answer).toBe("clarified");
  });

  it("partial map resume re-raises the remaining interrupt", async () => {
    const compiled = await compileGraph(parallelHitlSpec(), {});
    const r1 = await compiled.run({ threadId: "hitl-partial", onInterrupt: "fail" });
    expect(r1.interrupts).toHaveLength(2);

    const first = r1.interrupts![0]!;
    const firstNode =
      (first.payload as { data?: { __nodeId?: string } } | undefined)?.data?.__nodeId;
    const resumeValue = firstNode === "gate-b" ? { answer: "later" } : { approved: true };

    const r2 = await compiled.resume({
      threadId: "hitl-partial",
      resume: { [first.id]: resumeValue },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("interrupted");
    expect(r2.interrupts).toHaveLength(1);
    expect(r2.interrupts![0]!.id).not.toBe(first.id);

    const remaining = r2.interrupts![0]!;
    const remainingNode =
      (remaining.payload as { data?: { __nodeId?: string } } | undefined)?.data?.__nodeId;
    const remainingValue =
      remainingNode === "gate-b" ? { answer: "clarified" } : { approved: true };
    const r3 = await compiled.resume({
      threadId: "hitl-partial",
      resume: { [remaining.id]: remainingValue },
      onInterrupt: "fail",
    });
    expect(r3.status).toBe("completed");
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
