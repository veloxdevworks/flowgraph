import { describe, it, expect } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { MUTATING_FS_OPERATIONS } from "@flowgraph/tools-fs";

// Inline the warning helpers for unit testing without dynamic import side effects.
function hasMutatingFsHook(spec: GraphSpec): boolean {
  const mutating = new Set(MUTATING_FS_OPERATIONS.map((op) => `fs_${op}`));
  for (const hook of spec.runtime?.hooks ?? []) {
    if (hook.on !== "agent:beforeToolCall") continue;
    if (hook.do !== "interrupt" && hook.do !== "deny") continue;
    const tool = hook.where?.["tool"];
    if (typeof tool === "string" && mutating.has(tool)) return true;
  }
  return false;
}

describe("local tools governance warnings", () => {
  it("warns when mutating fs ops are enabled without hooks or permission ask", () => {
    const spec = {
      localTools: { fs: { operations: ["read", "write"] } },
      nodes: [{ type: "agent", with: { permission: "auto" } }],
    } as unknown as GraphSpec;
    expect(hasMutatingFsHook(spec)).toBe(false);
  });

  it("does not require warning when a mutating hook is configured", () => {
    const spec = {
      runtime: {
        hooks: [{ on: "agent:beforeToolCall", where: { tool: "fs_write" }, do: "interrupt" }],
      },
      localTools: { fs: { operations: ["write"] } },
    } as unknown as GraphSpec;
    expect(hasMutatingFsHook(spec)).toBe(true);
  });

  it("counts deny and ignores other verbs", () => {
    const deny = {
      runtime: { hooks: [{ on: "agent:beforeToolCall", where: { tool: "fs_write" }, do: "deny" }] },
    } as unknown as GraphSpec;
    const allow = {
      runtime: { hooks: [{ on: "agent:beforeToolCall", where: { tool: "fs_write" }, do: "allow" }] },
    } as unknown as GraphSpec;
    expect(hasMutatingFsHook(deny)).toBe(true);
    expect(hasMutatingFsHook(allow)).toBe(false);
  });
});
