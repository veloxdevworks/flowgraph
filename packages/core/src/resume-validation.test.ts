import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { compileGraph } from "./compiler.js";
import type { GraphSpec } from "@flowgraph/spec";
import { interruptUntilValid } from "./runtime/resume-validation.js";

const titleSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
};

function single(node: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "resume-validation" },
    state: { channels: { out: { type: "object" } } },
    nodes: [{ id: "gate", ...node }],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

const workshop = (extra: Record<string, unknown> = {}) =>
  single({
    type: "workshop",
    with: { message: "Workshop", agenda: ["scope"], schema: titleSchema, output: { to: "out" }, ...extra },
  });

const form = (extra: Record<string, unknown> = {}) =>
  single({
    type: "hitl",
    with: { mode: "form", message: "Fill in", schema: titleSchema, output: { to: "out" }, ...extra },
  });

const review = (extra: Record<string, unknown> = {}) =>
  single({ type: "hitl", with: { mode: "review", message: "Review", output: { to: "out" }, ...extra } });

describe("interruptUntilValid (unit)", () => {
  it("re-issues the interrupt with the error until parse succeeds", () => {
    const answers = ["bad", "bad", "good"];
    const seen: Array<Record<string, unknown>> = [];
    const ctx = {
      interrupt<T>(p: { data?: unknown }): T {
        seen.push(p.data as Record<string, unknown>);
        return answers.shift() as T;
      },
    };
    const out = interruptUntilValid(
      ctx,
      { reason: "r", data: { base: 1 } },
      (v) => {
        if (v !== "good") throw new Error(`nope ${String(v)}`);
        return v;
      },
      { maxAttempts: 5 },
    );
    expect(out).toBe("good");
    expect(seen[0]).toEqual({ base: 1 });
    expect(seen[1]).toEqual({ base: 1, validationError: "nope bad", attempt: 1, maxAttempts: 5, exhausted: false });
    expect(seen[2]).toMatchObject({ attempt: 2, exhausted: false });
  });
});

describe("re-prompt on invalid resume", () => {
  it("workshop: bad then good resume succeeds", async () => {
    const g = await compileGraph(workshop(), {});
    expect((await g.run({ threadId: "rv-ws-1", onInterrupt: "fail" })).status).toBe("interrupted");
    const bad = await g.resume({ threadId: "rv-ws-1", resume: { output: { title: 7 } }, onInterrupt: "fail" });
    expect(bad.status).toBe("interrupted");
    expect(bad.interrupts?.[0]?.validationError).toMatch(/title/);
    const good = await g.resume({ threadId: "rv-ws-1", resume: { output: { title: "SSO" } }, onInterrupt: "fail" });
    expect(good.status).toBe("completed");
    expect((good.state["out"] as { output: { title: string } }).output.title).toBe("SSO");
  });

  it("hitl form: bad then good resume succeeds", async () => {
    const g = await compileGraph(form(), {});
    await g.run({ threadId: "rv-form-1", onInterrupt: "fail" });
    const bad = await g.resume({ threadId: "rv-form-1", resume: { nope: true }, onInterrupt: "fail" });
    expect(bad.status).toBe("interrupted");
    expect(bad.interrupts?.[0]).toMatchObject({ kind: "form", attempt: 1, maxAttempts: 3 });
    const good = await g.resume({ threadId: "rv-form-1", resume: { title: "Epic" }, onInterrupt: "fail" });
    expect(good.status).toBe("completed");
    expect((good.state["out"] as { title: string }).title).toBe("Epic");
  });

  it("workshop: exhausting maxResumeAttempts fails cleanly; thread stays inspectable and resumable", async () => {
    const checkpointer = new MemorySaver();
    const g = await compileGraph(workshop({ maxResumeAttempts: 2 }), { checkpointer });
    await g.run({ threadId: "rv-ws-2", onInterrupt: "fail" });
    const a1 = await g.resume({ threadId: "rv-ws-2", resume: { output: {} }, onInterrupt: "fail" });
    expect(a1.status).toBe("interrupted");
    expect(a1.interrupts?.[0]).toMatchObject({ attempt: 1, maxAttempts: 2 });

    const a2 = await g.resume({ threadId: "rv-ws-2", resume: { output: { title: 1 } }, onInterrupt: "fail" });
    expect(a2.status).toBe("error");
    expect(a2.error?.name).toBe("ResumeAttemptsExhaustedError");
    expect(a2.error?.message).toMatch(/node "gate" rejected 2 of 2 allowed resume answers/);
    expect(a2.error?.message).toMatch(/still pending/);
    expect(a2.interrupts?.[0]?.exhausted).toBe(true);

    // Inspectable: the interrupt is still pending on the node.
    const snap = await g.getState("rv-ws-2");
    expect(snap?.next).toEqual(["gate"]);
    expect(snap?.interrupts[0]).toMatchObject({ kind: "workshop", exhausted: true, attempt: 2 });

    // A later valid resume works, even from a freshly compiled graph (process restart).
    const g2 = await compileGraph(workshop({ maxResumeAttempts: 2 }), { checkpointer });
    const ok = await g2.resume({ threadId: "rv-ws-2", resume: { output: { title: "Late" } }, onInterrupt: "fail" });
    expect(ok.status).toBe("completed");
    expect((ok.state["out"] as { output: { title: string } }).output.title).toBe("Late");
    const after = await g2.getState("rv-ws-2");
    expect(after?.next).toEqual([]);
    expect(after?.interrupts).toEqual([]);
  });

  it("hitl review: exhausted on an invalid decision, then a valid decision completes", async () => {
    const g = await compileGraph(review({ maxResumeAttempts: 1 }), {});
    await g.run({ threadId: "rv-rev-1", onInterrupt: "fail" });
    const bad = await g.resume({ threadId: "rv-rev-1", resume: { decision: "maybe" }, onInterrupt: "fail" });
    expect(bad.status).toBe("error");
    expect(bad.error?.message).toMatch(/invalid review decision "maybe"/);
    // A second bad answer after exhaustion still fails without bricking.
    const bad2 = await g.resume({ threadId: "rv-rev-1", resume: { decision: "later" }, onInterrupt: "fail" });
    expect(bad2.status).toBe("error");
    expect(bad2.interrupts?.[0]?.attempt).toBe(2);
    const ok = await g.resume({ threadId: "rv-rev-1", resume: { decision: "approve", feedback: "lgtm" }, onInterrupt: "fail" });
    expect(ok.status).toBe("completed");
    expect(ok.state["out"]).toMatchObject({ decision: "approve", approved: true, feedback: "lgtm" });
  });

  it("CLI-style resolveInterrupt loop sees the validation error and can answer again", async () => {
    const g = await compileGraph(form(), {});
    const answers: unknown[] = [{ bad: 1 }, { title: "Fixed" }];
    const seen: Array<string | undefined> = [];
    const r = await g.run({
      threadId: "rv-form-2",
      onInterrupt: "prompt",
      resolveInterrupt: (its) => {
        seen.push(its[0]?.validationError);
        return answers.shift();
      },
    });
    expect(r.status).toBe("completed");
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toMatch(/title/);
  });

  it("map-keyed HITL: one bad item re-prompts alone, siblings keep their answers", async () => {
    const spec = {
      metadata: { name: "map-form" },
      state: { channels: { items: { type: "array" }, results: { type: "array" } } },
      nodes: [
        {
          id: "map-items",
          type: "map",
          with: {
            over: "{{ state.items }}",
            as: "it",
            concurrency: 2,
            node: {
              type: "hitl",
              with: {
                mode: "form",
                message: "Name item {{ item.it }}",
                schema: titleSchema,
                maxResumeAttempts: 2,
                output: { to: "itemResult" },
              },
            },
            collect: { to: "results" },
          },
        },
      ],
      edges: [
        { from: "START", to: "map-items" },
        { from: "map-items", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;
    const g = await compileGraph(spec, {});
    const r1 = await g.run({ threadId: "rv-map-1", input: { items: ["a", "b"] }, onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");
    expect(r1.interrupts).toHaveLength(2);
    const byReason = new Map((r1.interrupts ?? []).map((i) => [i.reason, i.id]));
    const idA = byReason.get("Name item a")!;
    const idB = byReason.get("Name item b")!;

    const r2 = await g.resume({
      threadId: "rv-map-1",
      resume: { [idA]: { title: 3 }, [idB]: { title: "B" } },
      onInterrupt: "fail",
    });
    expect(r2.status).toBe("interrupted");
    expect(r2.interrupts).toHaveLength(1);
    expect(r2.interrupts?.[0]).toMatchObject({ id: idA, reason: "Name item a", attempt: 1 });

    // Exhaust item a, then answer it correctly: the thread is not bricked.
    const r3 = await g.resume({ threadId: "rv-map-1", resume: { [idA]: {} }, onInterrupt: "fail" });
    expect(r3.status).toBe("error");
    expect(r3.interrupts?.[0]).toMatchObject({ id: idA, exhausted: true });

    const r4 = await g.resume({ threadId: "rv-map-1", resume: { [idA]: { title: "A" } }, onInterrupt: "fail" });
    expect(r4.status).toBe("completed");
    expect((r4.state["results"] as Array<{ title: string }>).map((x) => x.title)).toEqual(["A", "B"]);
  });

  it("rejects a non-positive maxResumeAttempts at compile time", async () => {
    await expect(compileGraph(form({ maxResumeAttempts: 0 }), {})).rejects.toThrow(/maxResumeAttempts/);
  });
});
