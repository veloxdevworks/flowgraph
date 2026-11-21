import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { FlowgraphEvent } from "./events.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg-edge-guard-"));
  dirs.push(dir);
  return dir;
}

function graph(when: string, extraNodes: unknown[] = [], on?: unknown): GraphSpec {
  registerFunction("edgeGuardMark", (input) => [(input as { id: string }).id]);
  registerFunction("edgeGuardFail", () => {
    throw new Error("expected failure");
  });
  const mark = (id: string) => ({ id, type: "function", with: { fn: "edgeGuardMark", input: { id }, output: { to: "seen" } } });
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "edge-guard" },
    state: { channels: { seen: { type: "array", reducer: "append" }, n: { type: "number", default: 0 } } },
    nodes: [
      on ? { id: "a", type: "function", with: { fn: "edgeGuardMark", input: { id: "a" }, output: { to: "seen" } }, on } : mark("a"),
      mark("yes"),
      mark("fallback"),
      ...extraNodes,
    ],
    edges: [
      { from: "START", to: "a" },
      { from: "a", branch: [{ when, to: "yes" }, { default: true, to: "fallback" }] },
      { from: "yes", to: "END" },
      { from: "fallback", to: "END" },
    ],
  });
}

describe("branch guard evaluation errors", () => {
  it("fails the run with EDGE_GUARD_ERROR instead of taking the default branch", async () => {
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(graph("{{ nosuchfn(state.n) }}"), { workspace: workspace(), sinks: [(e) => { events.push(e); }] });
    const r = await compiled.run();
    expect(r.status).toBe("error");
    expect((r.error as { code?: string }).code).toBe("EDGE_GUARD_ERROR");
    expect(r.error?.message).toContain('Edge "a" -> "yes"');
    expect(r.error?.message).toContain("nosuchfn");
    const issue = r.issues?.find((i) => i.code === "EDGE_GUARD_ERROR");
    expect(issue).toMatchObject({ severity: "error", nodeId: "a", detail: { from: "a", to: "yes", when: "{{ nosuchfn(state.n) }}" } });
    expect(events.some((e) => e.type === "run.issue" && (e.data as { code?: string }).code === "EDGE_GUARD_ERROR")).toBe(true);
    expect(events.some((e) => e.type === "node.start" && (e.data as { nodeId?: string }).nodeId === "fallback")).toBe(false);
  });

  it("still follows the default branch when the guard is false", async () => {
    const r = await (await compileGraph(graph("{{ state.n > 5 }}"), { workspace: workspace() })).run();
    expect(r.status).toBe("completed");
    expect(r.state.seen).toEqual(["a", "fallback"]);
    expect(r.issues ?? []).toEqual([]);
  });

  it("treats a missing nested path as false, not as an error", async () => {
    const r = await (await compileGraph(graph("{{ state.missing.deep == 1 }}"), { workspace: workspace() })).run();
    expect(r.status).toBe("completed");
    expect(r.state.seen).toEqual(["a", "fallback"]);
  });

  it("fails the run when the source node also has a recovery route", async () => {
    const spec = graph("{{ nosuchfn(state.n) }}", [], { error: "route:fallback" });
    const r = await (await compileGraph(spec, { workspace: workspace() })).run();
    expect(r.status).toBe("error");
    expect((r.error as { code?: string }).code).toBe("EDGE_GUARD_ERROR");
    expect(r.issues?.map((i) => i.code)).toContain("EDGE_GUARD_ERROR");
  });
});
