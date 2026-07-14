import { describe, it, expect, beforeAll } from "vitest";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
import { registerFunction } from "./nodes/code.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

beforeAll(() => {
  registerFunction("emitA", () => "a");
  registerFunction("emitB", () => "b");
});

function parallelFanOutSpec(reducer: "append" | undefined): GraphSpec {
  return {
    metadata: { name: "parallel-fanout" },
    state: {
      channels: {
        tags: reducer === "append" ? { type: "array", reducer: "append" } : { type: "array" },
      },
    },
    nodes: [
      { id: "branch-a", type: "code", with: { fn: "emitA", output: { to: "tags" } } },
      { id: "branch-b", type: "code", with: { fn: "emitB", output: { to: "tags" } } },
    ],
    edges: [
      { from: "START", to: ["branch-a", "branch-b"] },
      { from: "branch-a", to: "END" },
      { from: "branch-b", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

describe("parallel fan-out reducer behavior", () => {
  it("append preserves both branch writes", async () => {
    const spec = parallelFanOutSpec("append");
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    expect([...(r.state["tags"] as string[])].sort()).toEqual(["a", "b"]);
  });

  it("lastWrite keeps only one branch write", async () => {
    const spec = parallelFanOutSpec(undefined);
    const compiled = await compileGraph(spec, {});
    const r = await compiled.run({ input: {} });
    expect(r.status).toBe("completed");
    const tags = r.state["tags"] as string[];
    expect(tags).toHaveLength(1);
    expect(["a", "b"]).toContain(tags[0]);
  });
});

describe("validateSpec graph lint", () => {
  it("warns when append reducer is paired with a non-array channel", () => {
    const diags = validateSpec({
      metadata: { name: "bad-reducer" },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
      state: { channels: { x: { type: "string", reducer: "append" } } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "REDUCER_TYPE_MISMATCH")).toBe(true);
  });

  it("errors on unregistered custom reducer", () => {
    const diags = validateSpec({
      metadata: { name: "missing-custom" },
      nodes: [],
      edges: [{ from: "START", to: "END" }],
      state: { channels: { x: { type: "array", reducer: "custom:notRegisteredHere" } } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "UNREGISTERED_REDUCER" && d.severity === "error")).toBe(true);
  });

  it("warns for nodes not reachable from START", () => {
    const diags = validateSpec({
      metadata: { name: "orphan" },
      nodes: [
        { id: "live", type: "code", with: { fn: "emitA", output: { to: "tags" } } },
        { id: "orphan", type: "code", with: { fn: "emitB", output: { to: "tags" } } },
      ],
      edges: [
        { from: "START", to: "live" },
        { from: "live", to: "END" },
      ],
      state: { channels: { tags: { type: "array", reducer: "append" } } },
      runtime: { checkpoint: { enabled: false } },
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "UNREACHABLE_FROM_START" && d.message.includes("orphan"))).toBe(true);
  });
});

describe("validateSpec node config", () => {
  it("errors on unregistered node type", () => {
    const diags = validateSpec({
      metadata: { name: "unknown-type" },
      nodes: [{ id: "x", type: "not-a-real-type", with: {} }],
      edges: [
        { from: "START", to: "x" },
        { from: "x", to: "END" },
      ],
    } as unknown as GraphSpec);
    expect(
      diags.some(
        (d) =>
          d.code === "UNKNOWN_NODE_TYPE" &&
          d.severity === "error" &&
          d.path === "nodes.x.type",
      ),
    ).toBe(true);
  });

  it("errors when hitl with is missing required message", () => {
    const diags = validateSpec({
      metadata: { name: "bad-hitl" },
      nodes: [{ id: "gate", type: "hitl", with: { mode: "approve" } }],
      edges: [
        { from: "START", to: "gate" },
        { from: "gate", to: "END" },
      ],
    } as unknown as GraphSpec);
    const cfg = diags.filter((d) => d.code === "NODE_CONFIG_ERROR");
    expect(cfg.length).toBeGreaterThan(0);
    expect(cfg.some((d) => d.path?.includes("nodes.gate.with") && d.message.includes("message"))).toBe(
      true,
    );
  });

  it("does not emit NODE_CONFIG_ERROR for a valid hitl node", () => {
    const diags = validateSpec({
      metadata: { name: "ok-hitl" },
      nodes: [{ id: "gate", type: "hitl", with: { mode: "approve", message: "OK?" } }],
      edges: [
        { from: "START", to: "gate" },
        { from: "gate", to: "END" },
      ],
    } as unknown as GraphSpec);
    expect(diags.some((d) => d.code === "NODE_CONFIG_ERROR")).toBe(false);
    expect(diags.some((d) => d.code === "UNKNOWN_NODE_TYPE")).toBe(false);
  });
});
