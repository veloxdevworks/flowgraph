import { describe, it, expect } from "vitest";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { unconditionalFanOutDiagnostics } from "./validate-graph.js";

describe("unconditionalFanOutDiagnostics", () => {
  it("warns on multi-target to edges", () => {
    const spec = {
      metadata: { name: "fan" },
      state: { channels: {} },
      nodes: [
        { id: "hitl", type: "hitl", with: { mode: "approve", message: "ok" } },
        { id: "a", type: "shell", with: { command: "echo a" } },
        { id: "b", type: "shell", with: { command: "echo b" } },
      ],
      edges: [
        { from: "START", to: "hitl" },
        { from: "hitl", to: ["a", "b"] },
        { from: "a", to: "END" },
        { from: "b", to: "END" },
      ],
    } as unknown as GraphSpec;

    const diags = unconditionalFanOutDiagnostics(spec);
    expect(diags.some((d) => d.code === "UNCONDITIONAL_FANOUT")).toBe(true);
  });

  it("does not warn when branch edges have when/default", () => {
    const spec = {
      metadata: { name: "branch" },
      state: { channels: {} },
      nodes: [
        { id: "hitl", type: "hitl", with: { mode: "approve", message: "ok" } },
        { id: "a", type: "shell", with: { command: "echo a" } },
        { id: "b", type: "shell", with: { command: "echo b" } },
      ],
      edges: [
        { from: "START", to: "hitl" },
        {
          from: "hitl",
          branch: [
            { when: "{{ state.ok }}", to: "a" },
            { default: true, to: "b" },
          ],
        },
        { from: "a", to: "END" },
        { from: "b", to: "END" },
      ],
    } as unknown as GraphSpec;

    expect(unconditionalFanOutDiagnostics(spec)).toEqual([]);
  });

  it("skips router sources (routes own the destinations)", () => {
    const spec = {
      metadata: { name: "r" },
      state: { channels: {} },
      nodes: [
        {
          id: "route",
          type: "router",
          with: { routes: { a: { to: "a", default: true } } },
        },
        { id: "a", type: "shell", with: { command: "echo" } },
      ],
      edges: [
        { from: "START", to: "route" },
        { from: "route", to: ["a", "END"] },
      ],
    } as unknown as GraphSpec;

    expect(unconditionalFanOutDiagnostics(spec)).toEqual([]);
  });
});
