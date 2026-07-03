/**
 * Shared permission + hook governance for intelligent-node tool calls.
 *
 * Used by intelligent.ts invokeTool and by provider adapters that execute
 * provider-native tools (Claude canUseTool, Cursor customTools, etc.).
 */

import type { NodeRunContext } from "../context.js";

export interface GovernanceCtx {
  node: NodeRunContext;
  state: Record<string, unknown>;
  permission: "auto" | "ask" | "deny";
}

export async function requireToolApproval(
  ctx: NodeRunContext,
  tool: string,
  args: unknown,
  reason: string,
): Promise<void> {
  const approval = ctx.interrupt<{ approved?: boolean } | boolean>({
    reason,
    kind: "approval",
    data: { tool, args },
  });
  const approved = typeof approval === "boolean" ? approval : approval?.approved !== false;
  if (!approved) {
    throw new Error(`Tool call "${tool}" denied by human reviewer.`);
  }
}

/**
 * Runs permission:ask HITL + intelligent:beforeToolCall (veto/interrupt/mutate).
 * Returns (possibly mutated) args; throws on deny/veto.
 */
export async function checkToolCall(
  g: GovernanceCtx,
  tool: string,
  args: unknown,
): Promise<unknown> {
  if (g.permission === "deny") {
    throw new Error(`Tool calls are disabled for this intelligent node (permission: deny).`);
  }

  let callArgs = args;
  if (g.permission === "ask") {
    await requireToolApproval(g.node, tool, callArgs, "Approve tool call");
  }

  if (g.node.hooks?.has("intelligent:beforeToolCall")) {
    const r = await g.node.hooks.run("intelligent:beforeToolCall", {
      state: g.state,
      run: g.node.meta,
      payload: { nodeId: g.node.nodeId, nodeType: g.node.nodeType, tool, args: callArgs },
    });
    const c = r.control;
    if (c?.kind === "veto") {
      throw new Error(`Tool call "${tool}" vetoed by hook: ${c.reason}`);
    }
    if (c?.kind === "interrupt") {
      await requireToolApproval(g.node, tool, callArgs, c.reason);
    }
    if (r.payload.args !== undefined) callArgs = r.payload.args;
  }

  return callArgs;
}

/** Runs intelligent:afterToolCall (mutate). Returns (possibly mutated) result. */
export async function reportToolResult(
  g: GovernanceCtx,
  tool: string,
  args: unknown,
  result: unknown,
): Promise<unknown> {
  let finalResult = result;
  if (g.node.hooks?.has("intelligent:afterToolCall")) {
    const r = await g.node.hooks.run("intelligent:afterToolCall", {
      state: g.state,
      run: g.node.meta,
      payload: { nodeId: g.node.nodeId, nodeType: g.node.nodeType, tool, args, result: finalResult },
    });
    if (r.payload.result !== undefined) finalResult = r.payload.result;
  }
  return finalResult;
}
