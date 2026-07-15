import { describe, it, expect } from "vitest";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

/**
 * Router drives exclusive routing via Command{ goto } alone — no duplicate
 * `branch` edge on `spec.edges` (the historical workaround).
 */
function routerOnlySpec(_flag: string): GraphSpec {
  return {
    metadata: { name: "router-goto" },
    state: {
      channels: {
        flag: { type: "string" },
        path: { type: "string" },
      },
    },
    nodes: [
      {
        id: "route",
        type: "router",
        with: {
          mode: "rules",
          routes: {
            yes: { when: "{{ state.flag == 'yes' }}", to: "take-yes" },
            no: { when: "{{ state.flag == 'no' }}", to: "take-no" },
            default: { default: true, to: "take-no" },
          },
        },
      },
      {
        id: "take-yes",
        type: "function",
        with: { fn: "emitYes", output: { to: "path" } },
      },
      {
        id: "take-no",
        type: "function",
        with: { fn: "emitNo", output: { to: "path" } },
      },
    ],
    edges: [
      { from: "START", to: "route" },
      // No outgoing edges from `route` — Command.goto + ends must drive flow.
      { from: "take-yes", to: "END" },
      { from: "take-no", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("router Command.goto", () => {
  registerFunction("emitYes", () => "yes");
  registerFunction("emitNo", () => "no");

  it("routes to the matched branch without a duplicate branch edge", async () => {
    const compiled = await compileGraph(routerOnlySpec("yes"), {});
    const started: string[] = [];
    compiled.events.subscribe((e) => {
      if (e.type === "node.start" && typeof (e.data as { nodeId?: string }).nodeId === "string") {
        started.push((e.data as { nodeId: string }).nodeId);
      }
    });

    const r = await compiled.run({ input: { flag: "yes" } });
    expect(r.status).toBe("completed");
    expect(r.state["path"]).toBe("yes");
    expect(started).toContain("take-yes");
    expect(started).not.toContain("take-no");
  });

  it("falls through to the default route", async () => {
    const compiled = await compileGraph(routerOnlySpec("maybe"), {});
    const started: string[] = [];
    compiled.events.subscribe((e) => {
      if (e.type === "node.start" && typeof (e.data as { nodeId?: string }).nodeId === "string") {
        started.push((e.data as { nodeId: string }).nodeId);
      }
    });

    const r = await compiled.run({ input: { flag: "maybe" } });
    expect(r.status).toBe("completed");
    expect(r.state["path"]).toBe("no");
    expect(started).toContain("take-no");
    expect(started).not.toContain("take-yes");
  });

  it("overrides an unconditional fan-out edge from the router", async () => {
    const spec = routerOnlySpec("yes");
    // Simulate the UI bug: parallel fan-out from the router to both targets.
    spec.edges = [
      { from: "START", to: "route" },
      { from: "route", to: ["take-yes", "take-no"] },
      { from: "take-yes", to: "END" },
      { from: "take-no", to: "END" },
    ];

    const compiled = await compileGraph(spec, {});
    const started: string[] = [];
    compiled.events.subscribe((e) => {
      if (e.type === "node.start" && typeof (e.data as { nodeId?: string }).nodeId === "string") {
        started.push((e.data as { nodeId: string }).nodeId);
      }
    });

    const r = await compiled.run({ input: { flag: "yes" } });
    expect(r.status).toBe("completed");
    expect(r.state["path"]).toBe("yes");
    expect(started).toContain("take-yes");
    expect(started).not.toContain("take-no");
  });
});
