import { describe, it, expect } from "vitest";
import { checkToolCall, reportToolResult } from "./providers/governance.js";
import { createHookBus } from "./hooks/bus.js";
import type { NodeRunContext } from "./context.js";

function fakeNodeCtx(overrides: Partial<NodeRunContext> = {}): NodeRunContext {
  const hooks = createHookBus();
  return {
    nodeId: "agent",
    nodeType: "agent",
    meta: { runId: "r1", startedAt: new Date().toISOString(), graph: "test" },
    config: {},
    secrets: { get: async () => undefined },
    events: { emit: () => {}, subscribe: () => () => {} },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    workspace: "/tmp",
    render: (t) => t,
    emit: () => {},
    interrupt: () => true,
    once: async (_k, fn) => fn(),
    hooks,
    ...overrides,
  } as NodeRunContext;
}

describe("tool call governance", () => {
  it("deny throws before tool execution", async () => {
    const g = { node: fakeNodeCtx(), state: {}, permission: "deny" as const };
    await expect(checkToolCall(g, "fs_write", { path: "x" })).rejects.toThrow("permission: deny");
  });

  it("ask triggers interrupt for approval", async () => {
    let interrupted = false;
    const node = fakeNodeCtx({
      interrupt: <T = unknown>(): T => {
        interrupted = true;
        return true as T;
      },
    });
    const g = { node, state: {}, permission: "ask" as const };
    await checkToolCall(g, "lookup", { q: 1 });
    expect(interrupted).toBe(true);
  });

  it("beforeToolCall veto blocks the call", async () => {
    const node = fakeNodeCtx();
    node.hooks!.register({
      phase: "agent:beforeToolCall",
      where: { tool: "fs_write" },
      handler: () => ({ kind: "veto", reason: "no writes" }),
    });
    const g = { node, state: {}, permission: "auto" as const };
    await expect(checkToolCall(g, "fs_write", {})).rejects.toThrow("vetoed by hook");
  });

  it("beforeToolCall mutates args", async () => {
    const node = fakeNodeCtx();
    node.hooks!.register({
      phase: "agent:beforeToolCall",
      handler: () => ({ kind: "mutate", payload: { args: { redacted: true } } }),
    });
    const g = { node, state: {}, permission: "auto" as const };
    const args = await checkToolCall(g, "lookup", { secret: "x" });
    expect(args).toEqual({ redacted: true });
  });

  it("afterToolCall mutates result", async () => {
    const node = fakeNodeCtx();
    node.hooks!.register({
      phase: "agent:afterToolCall",
      handler: () => ({ kind: "mutate", payload: { result: { masked: true } } }),
    });
    const g = { node, state: {}, permission: "auto" as const };
    const result = await reportToolResult(g, "lookup", {}, { raw: "secret" });
    expect(result).toEqual({ masked: true });
  });
});
