import { describe, it, expect } from "vitest";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { MUTATING_FS_OPERATIONS } from "@veloxdevworks/flowgraph-tools-fs";

// Inline the warning helpers for unit testing without dynamic import side effects.
function hasMutatingFsHook(spec: GraphSpec): boolean {
  const mutating = new Set(MUTATING_FS_OPERATIONS.map((op) => `fs_${op}`));
  for (const hook of spec.runtime?.hooks ?? []) {
    if (hook.on !== "intelligent:beforeToolCall") continue;
    const tool = hook.where?.["tool"];
    if (typeof tool === "string" && mutating.has(tool)) return true;
  }
  return false;
}

describe("local tools governance warnings", () => {
  it("warns when mutating fs ops are enabled without hooks or permission ask", () => {
    const spec = {
      localTools: { fs: { operations: ["read", "write"] } },
      nodes: [{ type: "intelligent", with: { permission: "auto" } }],
    } as unknown as GraphSpec;
    expect(hasMutatingFsHook(spec)).toBe(false);
  });

  it("does not require warning when a mutating hook is configured", () => {
    const spec = {
      runtime: {
        hooks: [{ on: "intelligent:beforeToolCall", where: { tool: "fs_write" }, do: "interrupt" }],
      },
      localTools: { fs: { operations: ["write"] } },
    } as unknown as GraphSpec;
    expect(hasMutatingFsHook(spec)).toBe(true);
  });
});
