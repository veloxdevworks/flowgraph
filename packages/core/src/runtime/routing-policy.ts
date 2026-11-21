import type { GraphSpec, NodeSpec } from "@flowgraph/spec";
import { evalGuard, guardExpression } from "@flowgraph/expr";
import { Command } from "@langchain/langgraph";
import type { Hook } from "../hooks/types.js";

export const ROUTING_CHANNEL = "__routing";
const phases = new Set(["node:error"]);

export function recoveryTargets(spec: GraphSpec, node: NodeSpec, hooks: Hook[] = []): string[] {
  const targets = new Set<string>();
  if (node.on?.error?.startsWith("route:")) targets.add(node.on.error.slice(6));
  const innerPolicy =
    node.type === "map"
      ? (node.with?.node as { on?: { error?: string } } | undefined)?.on?.error
      : undefined;
  if (innerPolicy?.startsWith("route:")) targets.add(innerPolicy.slice(6));
  for (const hook of spec.runtime?.hooks ?? []) {
    if (!phases.has(hook.on) || !hook.do.startsWith("route:")) continue;
    if (hook.where?.nodeId && hook.where.nodeId !== node.id) continue;
    if (hook.where?.nodeType && hook.where.nodeType !== node.type) continue;
    targets.add(hook.do.slice(6));
  }
  // Programmatic hooks choose their target at runtime.
  if (
    hooks.some(
      (h) =>
        phases.has(h.phase) &&
        (!h.where?.nodeId || h.where.nodeId === node.id) &&
        (!h.where?.nodeType || h.where.nodeType === node.type),
    )
  ) {
    for (const n of spec.nodes) targets.add(n.id);
    targets.add("END");
  }
  return [...targets];
}

/** Code of the error raised when a branch `when` guard cannot be evaluated. */
export const EDGE_GUARD_ERROR = "EDGE_GUARD_ERROR";

export type EdgeGuardError = Error & {
  code: typeof EDGE_GUARD_ERROR;
  retryable: false;
  from: string;
  to: string;
  when: string;
};

export function isEdgeGuardError(err: unknown): err is EdgeGuardError {
  return err instanceof Error && (err as { code?: unknown }).code === EDGE_GUARD_ERROR;
}

/** Same no-match failure for a branch edge and a rules-mode router. */
export const NO_MATCH = "NO_MATCH";

export type NoMatchError = Error & {
  code: typeof NO_MATCH;
  retryable: false;
  from?: string;
};

export function isNoMatchError(err: unknown): err is NoMatchError {
  return err instanceof Error && (err as { code?: unknown }).code === NO_MATCH;
}

export function noMatchError(subject: string, from?: string): NoMatchError {
  const err = new Error(`${subject} has no matching route and no default`) as NoMatchError;
  err.code = NO_MATCH;
  err.retryable = false;
  if (from !== undefined) err.from = from;
  return err;
}

/** A router `when` that throws is a routing failure, not a node error to swallow or retry. */
export const ROUTER_GUARD_ERROR = "ROUTER_GUARD_ERROR";

export type RouterGuardError = Error & {
  code: typeof ROUTER_GUARD_ERROR;
  retryable: false;
};

export function isRouterGuardError(err: unknown): err is RouterGuardError {
  return err instanceof Error && (err as { code?: unknown }).code === ROUTER_GUARD_ERROR;
}

export function routerGuardError(routerId: string, when: string, cause: unknown): RouterGuardError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const err = new Error(
    `router "${routerId}" guard \`${when}\` could not be evaluated: ${reason}`,
    { cause },
  ) as RouterGuardError;
  err.code = ROUTER_GUARD_ERROR;
  err.retryable = false;
  return err;
}

export function isRoutingFailure(err: unknown): boolean {
  return isNoMatchError(err) || isRouterGuardError(err);
}

/** Values a guard may read: state, the node input, config, and the run. */
export interface GuardScope {
  state: Record<string, unknown>;
  input?: Record<string, unknown> | undefined;
  config?: Record<string, unknown> | undefined;
  run?: Record<string, unknown> | undefined;
}

function guardScope(scope: GuardScope): Record<string, unknown> {
  return {
    state: scope.state,
    input: scope.input ?? {},
    config: scope.config ?? {},
    run: scope.run ?? {},
  };
}

/**
 * Evaluate one branch guard. A guard that throws (bad path, wrong type, unknown
 * function) fails the run: falling through to the default branch or END would
 * make a broken condition look like a normal decision.
 */
export function evalBranchGuard(
  from: string,
  branch: { to: string; when: string },
  scope: GuardScope,
): boolean {
  const expr = guardExpression(branch.when);
  try {
    return Boolean(evalGuard(expr, guardScope(scope)));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw Object.assign(
      new Error(`Edge "${from}" -> "${branch.to}": guard \`${branch.when}\` could not be evaluated: ${reason}`, { cause: err }),
      { code: EDGE_GUARD_ERROR, retryable: false as const, from, to: branch.to, when: branch.when },
    ) as EdgeGuardError;
  }
}

/** First matching `when`, otherwise the single default. No match fails the run. */
export function selectBranchTarget(
  from: string,
  branches: Array<{ to: string; when?: string | undefined; default?: boolean | undefined }>,
  scope: GuardScope,
): string {
  let fallback: string | undefined;
  for (const branch of branches) {
    const isDefault = branch.default === true;
    const when = branch.when?.trim();
    if (isDefault && when) {
      throw Object.assign(new Error(`Edge "${from}" -> "${branch.to}" sets both when and default`), {
        code: "BRANCH_ENTRY",
        retryable: false as const,
      });
    }
    if (!isDefault && !when) {
      throw Object.assign(new Error(`Edge "${from}" -> "${branch.to}" needs when or default`), {
        code: "BRANCH_ENTRY",
        retryable: false as const,
      });
    }
    if (isDefault) {
      fallback ??= branch.to;
      continue;
    }
    if (evalBranchGuard(from, { to: branch.to, when: when! }, scope)) return branch.to;
  }
  if (fallback === undefined) throw noMatchError(`Edge "${from}"`, from);
  return fallback;
}

export function normalTargets(spec: GraphSpec, id: string, scope: GuardScope): string[] {
  const targets = new Set<string>();
  for (const edge of spec.edges) {
    const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
    if (!sources.includes(id)) continue;
    if ("to" in edge)
      for (const to of Array.isArray(edge.to) ? edge.to : [edge.to]) targets.add(to);
    else targets.add(selectBranchTarget(id, edge.branch, scope));
  }
  return [...targets];
}

/** Select destinations after the update's reducers, without additive static edges. */
export function exclusiveRouting<T extends Record<string, unknown>, C>(
  id: string,
  enabled: boolean,
  run: (state: T, config?: C) => Promise<Record<string, unknown>>,
) {
  if (!enabled) return run;
  return async (state: T, config?: C): Promise<Record<string, unknown>> => {
    const result = await run(state, config);
    const command = result instanceof Command ? result : undefined;
    if (
      command?.goto == null &&
      (state[ROUTING_CHANNEL] as Record<string, unknown> | undefined)?.[id] == null
    ) {
      return command ? ((command.update as Record<string, unknown>) ?? {}) : result;
    }
    return {
      ...(command ? ((command.update as Record<string, unknown>) ?? {}) : result),
      [ROUTING_CHANNEL]: { [id]: command?.goto ?? null },
    };
  };
}
