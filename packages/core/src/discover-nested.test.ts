import { describe, it, expect } from "vitest";
import { discoverSkillUses } from "./discover-skills.js";
import { discoverAgentUses } from "./discover-agents.js";
import type { GraphSpec } from "@flowgraph/spec";

describe("nested preflight discovery", () => {
  it("walks map inner skill nodes and agent skill tools", () => {
    const spec = {
      metadata: { name: "nested" },
      nodes: [
        {
          id: "fan",
          type: "map",
          with: {
            over: "{{ state.items }}",
            node: { type: "skill", uses: "./skills/inner" },
          },
        },
        {
          id: "coder",
          type: "agent",
          with: {
            prompt: "go",
            tools: [{ skill: "./skills/run-tests" }],
          },
        },
      ],
      edges: [],
    } as unknown as GraphSpec;

    expect(discoverSkillUses(spec).sort()).toEqual(["./skills/inner", "./skills/run-tests"].sort());
  });

  it("walks nested agent defs", () => {
    const spec = {
      metadata: { name: "nested-agent" },
      nodes: [
        {
          id: "fan",
          type: "map",
          with: {
            over: "{{ state.items }}",
            node: { type: "agent", with: { agent: "./agents/impl", prompt: "x" } },
          },
        },
      ],
      edges: [],
    } as unknown as GraphSpec;
    expect(discoverAgentUses(spec)).toEqual(["./agents/impl"]);
  });

  it("discovers file-based subgraph embeddings", async () => {
    const { discoverSubgraphFileUses } = await import("./discover-skills.js");
    const spec = {
      metadata: { name: "parent" },
      nodes: [{ id: "embed", type: "subgraph", uses: "./child.graph.yaml", with: {} }],
      edges: [],
    } as unknown as GraphSpec;
    expect(discoverSubgraphFileUses(spec)).toEqual(["./child.graph.yaml"]);
  });
});
