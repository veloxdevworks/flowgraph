import { describe, it, expect } from "vitest";
import { compileGraph } from "./compiler.js";
import { mockProvider } from "./providers/index.js";
import type { GraphSpec } from "@flowgraph/spec";

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

  it("an in-process answer of false, null, or undefined denies the approval", async () => {
    for (const answer of [false, null, undefined]) {
      const compiled = await compileGraph(hitlGraph("approve"), {});
      let asked = 0;
      const r = await compiled.run({
        threadId: `hitl-deny-${String(answer)}`,
        onInterrupt: "prompt",
        resolveInterrupt: async () => {
          asked++;
          return answer;
        },
      });
      expect(r.error?.message).toBeUndefined();
      expect(r.status).toBe("completed");
      expect(asked).toBe(1);
      expect((r.state["gateResult"] as { approved: boolean }).approved).toBe(false);
    }
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
    expect(r2.status).toBe("interrupted");
    expect(r2.interrupts?.[0]?.validationError).toContain("Invalid choice");
    const r3 = await compiled.resume({ threadId: "hitl-bad", resume: "a", onInterrupt: "fail" });
    expect(r3.status).toBe("completed");
    expect((r3.state["gateResult"] as { choice: string }).choice).toBe("a");
  });

  it("approve mode records a falsy external resume as a denial", async () => {
    const compiled = await compileGraph(hitlGraph("approve"), {});
    for (const [i, answer] of [false, null, undefined, 0, ""].entries()) {
      const threadId = `hitl-ext-deny-${i}`;
      await compiled.run({ threadId, onInterrupt: "fail" });
      const r = await compiled.resume({ threadId, resume: answer, onInterrupt: "fail" });
      expect(r.status).toBe("completed");
      expect((r.state["gateResult"] as { approved: boolean }).approved).toBe(false);
    }
  });

  it("choice mode maps a numeric 1-based index to the choice string", async () => {
    const compiled = await compileGraph(hitlGraph("choice"), {});
    await compiled.run({ threadId: "hitl-num", onInterrupt: "fail" });
    const r = await compiled.resume({ threadId: "hitl-num", resume: 2, onInterrupt: "fail" });
    expect(r.status).toBe("completed");
    expect((r.state["gateResult"] as { choice: string }).choice).toBe("b");
  });

  it("choice mode accepts a valid answer after an invalid one, truthy or falsy", async () => {
    const compiled = await compileGraph(hitlGraph("choice"), {});
    const invalid: unknown[] = ["nope", 5, { choice: "nope" }, false, null, undefined, 0, ""];
    const valid: Array<[unknown, string]> = [["b", "b"], [2, "b"], ["1", "a"], [{ choice: "a" }, "a"]];
    let n = 0;
    for (const bad of invalid) {
      for (const [good, expected] of valid) {
        const threadId = `hitl-retry-${n++}`;
        await compiled.run({ threadId, onInterrupt: "fail" });
        const r1 = await compiled.resume({ threadId, resume: bad, onInterrupt: "fail" });
        expect(r1.status).toBe("interrupted");
        expect(r1.interrupts?.[0]?.validationError).toContain("Invalid choice");
        const r2 = await compiled.resume({ threadId, resume: good, onInterrupt: "fail" });
        expect(r2.status).toBe("completed");
        expect((r2.state["gateResult"] as { choice: string }).choice).toBe(expected);
      }
    }
  });

  it("choice mode re-prompts in process and accepts a valid answer after an invalid one", async () => {
    const compiled = await compileGraph(hitlGraph("choice"), {});
    for (const [i, answers] of [[5, 1], ["nope", 2], [0, "b"], [false, 1], [null, "a"]].entries()) {
      let asked = 0;
      const r = await compiled.run({
        threadId: `hitl-inproc-retry-${i}`,
        onInterrupt: "prompt",
        resolveInterrupt: async () => answers[asked++],
      });
      expect(r.status).toBe("completed");
      expect(asked).toBe(2);
      expect((r.state["gateResult"] as { choice: string }).choice).toBe(
        answers[1] === 1 || answers[1] === "a" ? "a" : "b",
      );
    }
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

  it("an in-process answer of false applies to every pending interrupt", async () => {
    const compiled = await compileGraph(parallelHitlSpec(), {});
    let asked = 0;
    const r = await compiled.run({
      threadId: "hitl-par-deny",
      onInterrupt: "prompt",
      resolveInterrupt: async (pending) => {
        asked++;
        expect(pending).toHaveLength(2);
        return false;
      },
    });
    expect(r.status).toBe("completed");
    expect(asked).toBe(1);
    expect((r.state["gateA"] as { approved: boolean }).approved).toBe(false);
    expect(r.state["gateB"]).toBeDefined();
  });

  it("an external resume of false applies to every pending interrupt", async () => {
    const compiled = await compileGraph(parallelHitlSpec(), {});
    const r1 = await compiled.run({ threadId: "hitl-par-ext-deny", onInterrupt: "fail" });
    expect(r1.interrupts).toHaveLength(2);
    const r2 = await compiled.resume({ threadId: "hitl-par-ext-deny", resume: false, onInterrupt: "fail" });
    expect(r2.status).toBe("completed");
    expect((r2.state["gateA"] as { approved: boolean }).approved).toBe(false);
    expect((r2.state["gateB"] as { answer: string }).answer).toBe("false");
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

  it("form mode validates resume against JSON Schema", async () => {
    const spec = hitlGraph("approve", {});
    spec.nodes[0]!.with = {
      mode: "form",
      message: "Fill in",
      schema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
      output: { to: "gateResult" },
    };
    const compiled = await compileGraph(spec, {});
    const r1 = await compiled.run({ threadId: "hitl-form", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.kind).toBe("form");

    const r2 = await compiled.resume({
      threadId: "hitl-form",
      resume: { title: "Epic" },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    expect((r2.state["gateResult"] as { title: string }).title).toBe("Epic");
  });

  it("question mode renders a missing templated message as empty, not the word null", async () => {
    const spec = hitlGraph("question", {
      message: "{{ state.interview.question }}",
    });
    spec.state = {
      channels: {
        gateResult: { type: "object" },
        interview: { type: "object" },
      },
    };
    const compiled = await compileGraph(spec, {});
    const r1 = await compiled.run({ threadId: "hitl-null-msg", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.reason).toBe("");
    expect(r1.interrupts?.[0]?.reason).not.toBe("null");
  });

  it("review mode maps approve/request-changes and feedback", async () => {
    const spec = hitlGraph("approve", {});
    spec.nodes[0]!.with = {
      mode: "review",
      message: "Review the diff",
      diff: { before: "a", after: "b" },
      output: { to: "gateResult" },
    };
    const compiled = await compileGraph(spec, {});
    const r1 = await compiled.run({ threadId: "hitl-review", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts?.[0]?.kind).toBe("review");
    const data = (r1.interrupts?.[0]?.payload as { data?: { diffStat?: string } }).data;
    expect(data?.diffStat).toBeTruthy();

    const r2 = await compiled.resume({
      threadId: "hitl-review",
      resume: { decision: "request-changes", feedback: "add tests" },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("completed");
    const out = r2.state["gateResult"] as { decision: string; feedback: string; approved: boolean };
    expect(out.decision).toBe("request-changes");
    expect(out.feedback).toBe("add tests");
    expect(out.approved).toBe(false);
  });
});
