import { describe, it, expect } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { defaultModelDiagnostics, unconditionalFanOutDiagnostics } from "./validate-graph.js";
import { staticGraphDiagnostics } from "./static-diagnostics.js";

describe("unconditionalFanOutDiagnostics", () => {
  it("does not warn on multi-target to edges", () => {
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
    expect(diags.some((d) => d.code === "UNCONDITIONAL_FANOUT")).toBe(false);
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
          with: { routes: [ { name: "a", to: "a", default: true } ] },
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

  it("warns when a branch has no default", () => {
    const spec = {
      metadata: { name: "branch" },
      state: { channels: {} },
      nodes: [
        { id: "a", type: "shell", with: { command: "echo a" } },
        { id: "b", type: "shell", with: { command: "echo b" } },
      ],
      edges: [
        { from: "START", to: "a" },
        { from: "a", branch: [{ when: "{{ false }}", to: "b" }] },
        { from: "b", to: "END" },
      ],
    } as unknown as GraphSpec;
    expect(unconditionalFanOutDiagnostics(spec).map((item) => item.code)).toEqual(["BRANCH_NO_DEFAULT"]);
  });
});

describe("default model and template guards", () => {
  it("warns when a default model has no default provider", () => {
    const spec = {
      metadata: { name: "model" },
      config: { defaults: { model: "claude-sonnet" } },
      nodes: [],
      edges: [],
    } as unknown as GraphSpec;
    expect(defaultModelDiagnostics(spec)).toEqual([
      {
        severity: "warning",
        code: "DEFAULT_MODEL_IGNORED",
        message: "config.defaults.model is ignored unless config.defaults.provider is set",
        path: "config.defaults.model",
      },
    ]);
    expect(defaultModelDiagnostics({
      ...spec,
      config: { defaults: { provider: "claude", model: "claude-sonnet" } },
    } as GraphSpec)).toEqual([]);
  });

  it("checks a nested when that is not a guard", () => {
    const spec = {
      metadata: { name: "when" },
      nodes: [{ id: "a", type: "shell", with: { command: "echo", when: "{{ nope() }}" } }],
      edges: [],
    } as unknown as GraphSpec;
    const diags = staticGraphDiagnostics(spec);
    expect(diags.some((item) => item.code === "EXPR_UNKNOWN_FUNCTION" && item.path === "nodes.a.with.when")).toBe(true);
  });
});
