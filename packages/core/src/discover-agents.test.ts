import { describe, it, expect } from "vitest";
import { discoverAgentUses } from "./discover-agents.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

describe("discoverAgentUses", () => {
  it("returns with.agent from top-level agent nodes", () => {
    const spec = {
      metadata: { name: "g" },
      state: { channels: {} },
      nodes: [
        { id: "a", type: "agent", with: { agent: "./agents/foo", prompt: "hi" } },
        { id: "b", type: "function", with: { fn: "x" } },
        { id: "c", type: "agent", with: { agent: "code-reviewer", prompt: "go" } },
        { id: "d", type: "agent", with: { prompt: "no agent ref" } },
      ],
      edges: [],
    } as unknown as GraphSpec;

    expect(discoverAgentUses(spec)).toEqual(["./agents/foo", "code-reviewer"]);
  });

  it("returns empty when no agent refs", () => {
    const spec = {
      metadata: { name: "g" },
      state: { channels: {} },
      nodes: [{ id: "a", type: "agent", with: { prompt: "hi" } }],
      edges: [],
    } as unknown as GraphSpec;

    expect(discoverAgentUses(spec)).toEqual([]);
  });
});
