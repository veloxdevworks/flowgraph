import { describe, it, expect } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { graphLintDiagnostics } from "./runtime/validate-graph.js";
import { hitlOutcomes, normalizeHitlRoutes, resolveHitlRoute } from "./nodes/hitl-routes.js";
import type { GraphSpec } from "@flowgraph/spec";

registerFunction("tookProto", () => "prototype");
registerFunction("tookProd", () => "production");
registerFunction("tookOther", () => "other");

function spec(withExtra: Record<string, unknown>, edges: unknown[] = []): GraphSpec {
  const full = build(withExtra, edges) as unknown as {
    nodes: { id: string; with?: { routes?: Record<string, unknown> } }[];
    edges: { from: string; to?: unknown }[];
  };
  // The engine refuses unreachable nodes, so keep only targets something points at.
  const gate = full.nodes[0]!;
  const referenced = new Set<string>();
  for (const r of Object.values(gate.with?.routes ?? {})) {
    referenced.add(typeof r === "string" ? r : (r as { to: string }).to);
  }
  for (const e of edges as { to?: string | string[] }[]) {
    for (const t of Array.isArray(e.to) ? e.to : e.to ? [e.to] : []) referenced.add(t);
  }
  full.nodes = full.nodes.filter((n) => n.id === "gate" || referenced.has(n.id));
  full.edges = full.edges.filter(
    (e) => e.from === "START" || e.from === "gate" || full.nodes.some((n) => n.id === e.from),
  );
  return full as unknown as GraphSpec;
}

function build(withExtra: Record<string, unknown>, edges: unknown[]): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "hitl-routes" },
    state: { channels: { picked: { type: "object" }, path: { type: "string" } } },
    nodes: [
      {
        id: "gate",
        type: "hitl",
        with: {
          mode: "choice",
          message: "Which track?",
          choices: ["prototype", "production"],
          output: { to: "picked" },
          routes: { prototype: "proto", production: { to: "prod", description: "full" } },
          ...withExtra,
        },
      },
      { id: "proto", type: "function", with: { fn: "tookProto", output: { to: "path" } } },
      { id: "prod", type: "function", with: { fn: "tookProd", output: { to: "path" } } },
      { id: "other", type: "function", with: { fn: "tookOther", output: { to: "path" } } },
    ],
    edges: [
      { from: "START", to: "gate" },
      { from: "proto", to: "END" },
      { from: "prod", to: "END" },
      { from: "other", to: "END" },
      ...edges,
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

async function answer(s: GraphSpec, thread: string, resume: unknown) {
  const compiled = await compileGraph(s, {});
  const started: string[] = [];
  const decisions: unknown[] = [];
  compiled.events.subscribe((e) => {
    const d = e.data as { nodeId?: string } | undefined;
    if (e.type === "node.start" && d?.nodeId) started.push(d.nodeId);
    if (e.type === "router.decision") decisions.push(e.data);
  });
  const r1 = await compiled.run({ threadId: thread, onInterrupt: "fail" });
  expect(r1.status).toBe("interrupted");
  const r2 = await compiled.resume({ threadId: thread, resume, onInterrupt: "fail" });
  return { r2, started, decisions };
}

describe("hitl routes", () => {
  it("goes to the node routed for the chosen answer, with no edges leaving the gate", async () => {
    const { r2, started, decisions } = await answer(spec({}), "hr-choice", { choice: "production" });
    expect(r2.status).toBe("completed");
    expect(r2.state["path"]).toBe("production");
    expect(started).toContain("prod");
    expect(started).not.toContain("proto");
    expect((r2.state["picked"] as { choice: string }).choice).toBe("production");
    expect(decisions[0]).toMatchObject({ chosen: "production", to: "prod", mode: "hitl" });
  });

  it("routes approve mode on approved / rejected", async () => {
    const s = spec({ mode: "approve", choices: undefined, routes: { approved: "proto", rejected: "other" } });
    const yes = await answer(s, "hr-yes", { approved: true });
    expect(yes.r2.state["path"]).toBe("prototype");
    const no = await answer(s, "hr-no", { approved: false });
    expect(no.r2.state["path"]).toBe("other");
  });

  it("routes review mode on the decision", async () => {
    const s = spec({
      mode: "review",
      choices: undefined,
      routes: { approve: "proto", "request-changes": "other" },
    });
    const r = await answer(s, "hr-review", { decision: "request-changes" });
    expect(r.r2.state["path"]).toBe("other");
  });

  it("uses the default route for an answer without its own", async () => {
    const s = spec({ choices: ["prototype", "production", "spike"], routes: { prototype: "proto", default: "other" } });
    const r = await answer(s, "hr-default", { choice: "spike" });
    expect(r.r2.state["path"]).toBe("other");
  });

  it("ignores plain edges leaving a routed gate", async () => {
    const s = spec({}, [{ from: "gate", to: ["proto", "prod"] }]);
    const { started } = await answer(s, "hr-edges", { choice: "production" });
    expect(started).toContain("prod");
    expect(started).not.toContain("proto");
  });

  it("without routes it still follows its edges", async () => {
    const s = spec({ routes: undefined }, [{ from: "gate", to: "proto" }]);
    const { r2 } = await answer(s, "hr-plain", { choice: "production" });
    expect(r2.state["path"]).toBe("prototype");
  });
});

describe("hitl routes lint", () => {
  const codes = (s: GraphSpec) => graphLintDiagnostics(s).map((d) => d.code);

  it("is quiet for a complete, routed gate (and sees route targets as reachable)", () => {
    const d = graphLintDiagnostics(spec({}));
    expect(d.filter((x) => x.code.startsWith("HITL_") || x.code.includes("UNREACHABLE"))).toEqual([]);
    expect(d.some((x) => x.code === "NO_PATH_TO_END")).toBe(false);
  });

  it("errors when an answer has no route and there is no default", () => {
    expect(codes(spec({ routes: { prototype: "proto" } }))).toContain("HITL_ROUTE_MISSING");
  });

  it("accepts a default route for the rest", () => {
    expect(codes(spec({ routes: { prototype: "proto", default: "prod" } }))).not.toContain("HITL_ROUTE_MISSING");
  });

  it("errors on routes for question / form modes", () => {
    expect(codes(spec({ mode: "question", choices: undefined }))).toContain("HITL_ROUTES_MODE");
  });

  it("errors on an unknown target and warns on a route that never matches", () => {
    const c = codes(spec({ routes: { prototype: "proto", production: "nowhere", typo: "prod" } }));
    expect(c).toContain("HITL_ROUTE_UNKNOWN_TARGET");
    expect(c).toContain("HITL_ROUTE_UNKNOWN_OUTCOME");
  });

  it("warns when templated choices have no default", () => {
    expect(codes(spec({ choices: ["{{ state.opts }}"], routes: { prototype: "proto" } }))).toContain(
      "HITL_ROUTES_NO_DEFAULT",
    );
  });

  it("warns about edges leaving the gate that are not route targets", () => {
    expect(codes(spec({}, [{ from: "gate", to: "other" }]))).toContain("HITL_ROUTES_EDGE_IGNORED");
  });
});

describe("hitl route helpers", () => {
  it("normalises string and object routes", () => {
    expect(normalizeHitlRoutes({ a: "x", b: { to: "y", description: "why" }, c: 3, d: "" })).toEqual({
      a: { to: "x" },
      b: { to: "y", description: "why" },
    });
  });

  it("knows each mode's outcomes", () => {
    expect(hitlOutcomes({ mode: "approve" })?.outcomes).toEqual(["approved", "rejected"]);
    expect(hitlOutcomes({ mode: "review" })?.outcomes).toEqual(["approve", "request-changes"]);
    expect(hitlOutcomes({ mode: "choice", choices: ["a", "b"] })).toEqual({ outcomes: ["a", "b"], dynamic: false });
    expect(hitlOutcomes({ mode: "choice", choices: ["{{ x }}"] })?.dynamic).toBe(true);
    expect(hitlOutcomes({ mode: "form" })).toBeUndefined();
  });

  it("resolves own route before default", () => {
    const routes = normalizeHitlRoutes({ a: "x", default: "d" });
    expect(resolveHitlRoute(routes, "a")?.route.to).toBe("x");
    expect(resolveHitlRoute(routes, "zzz")).toMatchObject({ key: "default", route: { to: "d" } });
    expect(resolveHitlRoute(normalizeHitlRoutes({ a: "x" }), "zzz")).toBeUndefined();
  });
});

describe("validateSpec with hitl routes", () => {
  it("counts route targets as inbound edges", async () => {
    const { validateSpec } = await import("./loader.js");
    const d = validateSpec(spec({}));
    expect(d.filter((x) => x.code === "NO_INBOUND_EDGE")).toEqual([]);
  });
});

describe("router merge recommendation", () => {
  const retry = (): GraphSpec =>
    ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "retry" },
      state: { channels: { choice: { type: "object" } } },
      nodes: [
        { id: "fetch", type: "function", with: { fn: "tookProto" } },
        {
          id: "ask",
          type: "hitl",
          with: { mode: "choice", message: "Retry?", choices: ["retry", "abort"], output: { to: "choice" } },
        },
        {
          id: "decide",
          type: "router",
          with: {
            mode: "rules",
            routes: {
              retry: { when: "{{ state.choice.choice == 'retry' }}", to: "fetch" },
              abort: { default: true, to: "END" },
            },
          },
        },
      ],
      edges: [
        { from: "START", to: "fetch" },
        { from: "fetch", to: "ask" },
        { from: "ask", to: "decide" },
        { from: "decide", branch: [{ to: "fetch" }, { to: "END" }] },
      ],
    }) as unknown as GraphSpec;

  it("recommends merging a router that only repeats the gate's answer, as info", () => {
    const d = graphLintDiagnostics(retry()).find((x) => x.code === "HITL_ROUTER_MERGEABLE");
    expect(d).toMatchObject({ severity: "info", path: "nodes.decide" });
    expect(d?.message).toContain('"ask"');
  });

  it("stays quiet when the router decides on more than the answer", () => {
    const s = retry();
    (s.nodes[2]!.with as { routes: Record<string, { when?: string }> }).routes["retry"]!.when =
      "{{ state.choice.choice == 'retry' && state.tries < 3 }}";
    expect(graphLintDiagnostics(s).some((x) => x.code === "HITL_ROUTER_MERGEABLE")).toBe(false);
  });
});
