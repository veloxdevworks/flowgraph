import { describe, it, expect } from "vitest";
import { discoverSkillUses } from "./discover-skills.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

describe("discoverSkillUses", () => {
  it("returns uses from top-level skill nodes", () => {
    const spec = {
      metadata: { name: "g" },
      state: { channels: {} },
      nodes: [
        { id: "a", type: "skill", uses: "./skills/foo" },
        { id: "b", type: "function", with: { fn: "x" } },
        { id: "c", type: "skill", uses: "alias/bar" },
      ],
      edges: [],
    } as unknown as GraphSpec;

    expect(discoverSkillUses(spec)).toEqual(["./skills/foo", "alias/bar"]);
  });

  it("returns empty when no skill nodes", () => {
    const spec = {
      metadata: { name: "g" },
      state: { channels: {} },
      nodes: [{ id: "a", type: "function", with: { fn: "x" } }],
      edges: [],
    } as unknown as GraphSpec;

    expect(discoverSkillUses(spec)).toEqual([]);
  });
});
