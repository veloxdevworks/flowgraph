/**
 * Shared output → state update helper.
 *
 * Default: every node writes its raw result under `state.outputs.<nodeId>`.
 * (LangGraph forbids a channel name equal to a node id, so we use a reserved
 * `outputs` object channel with mergeDeep.)
 * Optional `to` / `map` are additive projections. `none` opts out entirely.
 */

import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import type { OutputMapping } from "@veloxdevworks/flowgraph-spec";

/** Reserved channel holding per-node results: `state.outputs.<nodeId>`. */
export const OUTPUTS_CHANNEL = "outputs";

export function isOutputNone(output: unknown): boolean {
  if (output === "none") return true;
  if (output != null && typeof output === "object" && !Array.isArray(output)) {
    return (output as { none?: unknown }).none === true;
  }
  return false;
}

export interface ApplyOutputOpts {
  nodeId: string;
  /** Extra render scope (state, input, config, run, …). */
  scope?: Record<string, unknown>;
}

/**
 * Build a LangGraph state update from a node's raw result and optional mapping.
 *
 * - omitted / `{}` → `{ outputs: { [nodeId]: rawResult } }`
 * - `"none"` / `{ none: true }` → `{}`
 * - `{ to }` and/or `{ map }` → those writes plus the outputs slug
 */
export function applyOutput(
  output: OutputMapping | undefined,
  rawResult: unknown,
  opts: ApplyOutputOpts,
): Record<string, unknown> {
  if (isOutputNone(output)) return {};

  const update: Record<string, unknown> = {
    [OUTPUTS_CHANNEL]: { [opts.nodeId]: rawResult },
  };

  if (output == null || typeof output !== "object") return update;

  if (typeof output.to === "string" && output.to.trim()) {
    update[output.to.trim()] = rawResult;
  }

  if (output.map != null && typeof output.map === "object") {
    const scope = {
      result: rawResult,
      output: rawResult,
      ...(opts.scope ?? {}),
    };
    for (const [channel, expr] of Object.entries(output.map)) {
      if (!channel.trim()) continue;
      update[channel] = renderDeep(expr, scope);
    }
  }

  return update;
}
