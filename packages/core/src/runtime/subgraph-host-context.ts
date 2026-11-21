import type { NodeRunContext, RunConfig } from "../context.js";
import type { Hook, HookPhase } from "../hooks/types.js";
import type { McpHub } from "../mcp/types.js";

/** Compile-time host options, separate from a graph's effective runtime config. */
export const SUBGRAPH_HOST_CONTEXT = Symbol.for("flowgraph.subgraphHostContext");

interface SubgraphHostContext {
  hooks: Hook[];
  runConfig: Pick<RunConfig, "vars" | "defaults" | "permission">;
}

// A child executes nodes within the root invocation, not another run/interrupt lifecycle.
const CHILD_HOOK_PHASES = new Set<HookPhase>([
  "node:before",
  "node:after",
  "node:error",
  "agent:beforeStep",
  "agent:beforeToolCall",
  "agent:afterToolCall",
  "skill:beforeRun",
  "skill:afterRun",
  "router:beforeDecision",
  "router:afterDecision",
  "state:beforeUpdate",
  "checkpoint:beforeWrite",
]);

/** Own plain data without changing the identity/behavior of opaque host values. */
function copyPlainData<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return value;
  const existing = seen.get(value);
  if (existing) return existing as T;
  const copy = array ? [] : Object.create(prototype);
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ("value" in descriptor) descriptor.value = copyPlainData(descriptor.value, seen);
    // Preserve accessors rather than invoking caller code while capturing options.
    Object.defineProperty(copy, key, descriptor);
  }
  return copy as T;
}

function copyHostOverrides(
  runConfig?: Pick<RunConfig, "vars" | "defaults" | "permission">,
): SubgraphHostContext["runConfig"] {
  return {
    ...(runConfig?.vars ? { vars: copyPlainData(runConfig.vars) } : {}),
    ...(runConfig?.defaults ? { defaults: { ...runConfig.defaults } } : {}),
    ...(runConfig?.permission ? { permission: runConfig.permission } : {}),
  };
}

/** Snapshot only the host overrides that have run-tree semantics. */
export function captureSubgraphHostContext(options: {
  hooks?: Hook[];
  runConfig?: RunConfig;
}): SubgraphHostContext {
  return {
    hooks: (options.hooks ?? [])
      .filter((hook) => CHILD_HOOK_PHASES.has(hook.phase))
      .map((hook) => ({ ...hook, ...(hook.where ? { where: { ...hook.where } } : {}) })),
    runConfig: copyHostOverrides(options.runConfig),
  };
}

/**
 * In-process children share the exposed hub and host policy hooks. Never copy the
 * parent's effective config: its channels, aliases, paths and YAML defaults are
 * graph-local, and invocation identity/checkpoint/replay comes from RunnableConfig.
 */
export function subgraphHostOptions(ctx: NodeRunContext): {
  mcp?: McpHub;
  hooks?: Hook[];
  runConfig?: RunConfig;
} {
  const host = (ctx as unknown as Record<symbol, unknown>)[SUBGRAPH_HOST_CONTEXT] as
    SubgraphHostContext | undefined;
  return {
    ...(ctx.mcp ? { mcp: ctx.mcp } : {}),
    ...(host ? { hooks: host.hooks, runConfig: copyHostOverrides(host.runConfig) } : {}),
  };
}
