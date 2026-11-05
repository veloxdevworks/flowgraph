import { describe, expect, it } from "vitest";
import {
  analyzeRouterMerge,
  answerFromCondition,
  findMergeableRouters,
  mergeRouterIntoHitl,
  type MergeSpec,
} from "./hitl-merge.js";

/** The ai-http-loop retry gate: a choice, then a router that repeats it. */
function retrySpec(
  overrides: { gate?: Record<string, unknown>; routes?: Record<string, unknown> } = {},
): MergeSpec {
  return {
    nodes: [
      { id: "fetch", type: "http" },
      {
        id: "ask-retry",
        type: "hitl",
        with: {
          mode: "choice",
          message: "Retry?",
          choices: ["retry", "abort"],
          output: { to: "retryChoice" },
          ...overrides.gate,
        },
      },
      {
        id: "decide",
        type: "router",
        with: {
          mode: "rules",
          routes: overrides.routes ?? {
            retry: { when: "{{ retryChoice.choice == 'retry' }}", to: "fetch" },
            abort: { default: true, to: "END" },
          },
        },
      },
    ],
    edges: [
      { from: "START", to: "fetch" },
      { from: "fetch", to: "ask-retry" },
      { from: "ask-retry", to: "decide" },
      {
        from: "decide",
        branch: [{ to: "fetch" }, { to: "END" }],
      },
    ],
  };
}

describe("answerFromCondition", () => {
  const choices = ["a", "b"];
  it("reads choice and review comparisons, with or without the state prefix", () => {
    expect(answerFromCondition("{{ state.c.choice == 'a' }}", "c", "choice", choices)).toBe("a");
    expect(answerFromCondition('c.choice == "b"', "c", "choice", choices)).toBe("b");
    expect(answerFromCondition("{{ state.c.decision == 'a' }}", "c", "review", choices)).toBe("a");
  });
  it("reads approval comparisons", () => {
    const f = (e: string) => answerFromCondition(e, "ok", "approve", ["approved", "rejected"]);
    expect(f("{{ state.ok.approved == true }}")).toBe("approved");
    expect(f("{{ state.ok.approved }}")).toBe("approved");
    expect(f("{{ !state.ok.approved }}")).toBe("rejected");
    expect(f("{{ state.ok.approved == false }}")).toBe("rejected");
    expect(f("{{ state.ok.approved != true }}")).toBe("rejected");
  });
  it("refuses anything else", () => {
    expect(
      answerFromCondition("{{ state.c.choice == 'zzz' }}", "c", "choice", choices),
    ).toBeUndefined();
    expect(
      answerFromCondition("{{ state.other.choice == 'a' }}", "c", "choice", choices),
    ).toBeUndefined();
    expect(
      answerFromCondition("{{ state.c.choice == 'a' && state.n > 3 }}", "c", "choice", choices),
    ).toBeUndefined();
  });
});

describe("analyzeRouterMerge", () => {
  it("maps each route and spells the default out per answer", () => {
    const plan = analyzeRouterMerge(retrySpec(), "decide");
    expect(plan).toEqual({
      ok: true,
      routerId: "decide",
      hitlId: "ask-retry",
      routes: { retry: "fetch", abort: "END" },
    });
  });

  it("covers several answers with one default, in the gate's own order", () => {
    const spec = retrySpec({
      gate: { choices: ["retry", "skip", "abort"] },
      routes: {
        retry: { when: "{{ retryChoice.choice == 'retry' }}", to: "fetch" },
        other: { default: true, to: "END" },
      },
    });
    const plan = analyzeRouterMerge(spec, "decide");
    expect(plan.ok && plan.routes).toEqual({ retry: "fetch", skip: "END", abort: "END" });
  });

  it("keeps route descriptions", () => {
    const spec = retrySpec({
      routes: {
        retry: {
          when: "{{ retryChoice.choice == 'retry' }}",
          to: "fetch",
          description: "try again",
        },
        abort: { default: true, to: "END" },
      },
    });
    const plan = analyzeRouterMerge(spec, "decide");
    expect(plan.ok && plan.routes["retry"]).toEqual({ to: "fetch", description: "try again" });
  });

  it("works for approve gates", () => {
    const spec: MergeSpec = {
      nodes: [
        {
          id: "review",
          type: "hitl",
          with: { mode: "approve", message: "ok?", output: { to: "approval" } },
        },
        {
          id: "gate",
          type: "router",
          with: {
            routes: {
              approved: { when: "{{ state.approval.approved == true }}", to: "go" },
              rejected: { default: true, to: "redo" },
            },
          },
        },
        { id: "go", type: "function" },
        { id: "redo", type: "function" },
      ],
      edges: [
        { from: "START", to: "review" },
        { from: "review", to: "gate" },
      ],
    };
    const plan = analyzeRouterMerge(spec, "gate");
    expect(plan.ok && plan.routes).toEqual({ approved: "go", rejected: "redo" });
  });

  const refused = (spec: MergeSpec) => {
    const r = analyzeRouterMerge(spec, "decide");
    return r.ok ? "ok" : r.reason;
  };

  it("refuses conditions that do more than compare the answer", () => {
    const spec = retrySpec({
      routes: {
        retry: { when: "{{ retryChoice.choice == 'retry' && state.tries < 3 }}", to: "fetch" },
        abort: { default: true, to: "END" },
      },
    });
    expect(refused(spec)).toMatch(/does more than compare/);
  });

  it("refuses when an answer would have no route", () => {
    const spec = retrySpec({
      routes: { retry: { when: "{{ retryChoice.choice == 'retry' }}", to: "fetch" } },
    });
    expect(refused(spec)).toMatch(/No route for "abort"/);
  });

  it("refuses model routers, routers that write state, and several inbound edges", () => {
    expect(refused(retrySpec())).toBe("ok");
    const model = retrySpec();
    model.nodes[2]!.with = { ...model.nodes[2]!.with, mode: "model" };
    expect(refused(model)).toMatch(/rule-based/);
    const writes = retrySpec();
    writes.nodes[2]!.with = { ...writes.nodes[2]!.with, output: { to: "x" } };
    expect(refused(writes)).toMatch(/writes its choice/);
    const shared = retrySpec();
    shared.edges.push({ from: "fetch", to: "decide" });
    expect(refused(shared)).toMatch(/single gate/);
  });

  it("refuses gates that already route, lead elsewhere, or have no output channel", () => {
    expect(refused(retrySpec({ gate: { routes: { retry: "fetch", abort: "END" } } }))).toMatch(
      /already routes/,
    );
    const extra = retrySpec();
    extra.edges.push({ from: "ask-retry", to: "fetch" });
    expect(refused(extra)).toMatch(/also leads/);
    expect(refused(retrySpec({ gate: { output: undefined } }))).toMatch(/single channel/);
    expect(refused(retrySpec({ gate: { mode: "question", choices: undefined } }))).toMatch(
      /fixed set/,
    );
  });
});

describe("mergeRouterIntoHitl", () => {
  it("folds the router into the gate and drops its edges", () => {
    const result = mergeRouterIntoHitl(retrySpec(), "decide");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.nodes.map((n) => n.id)).toEqual(["fetch", "ask-retry"]);
    const gate = result.spec.nodes[1]!;
    expect(gate.with?.["routes"]).toEqual({ retry: "fetch", abort: "END" });
    // `routes` sits just before `output`.
    expect(Object.keys(gate.with!)).toEqual(["mode", "message", "choices", "routes", "output"]);
    expect(result.spec.edges).toEqual([
      { from: "START", to: "fetch" },
      { from: "fetch", to: "ask-retry" },
    ]);
  });

  it("finds mergeable routers and leaves a refused spec alone", () => {
    expect(findMergeableRouters(retrySpec())).toEqual([
      { routerId: "decide", hitlId: "ask-retry" },
    ]);
    const bad = retrySpec({ routes: { retry: { when: "{{ x }}", to: "fetch" } } });
    expect(findMergeableRouters(bad)).toEqual([]);
    expect(mergeRouterIntoHitl(bad, "decide").ok).toBe(false);
  });
});
