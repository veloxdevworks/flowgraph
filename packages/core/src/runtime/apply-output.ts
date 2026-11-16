/**
 * Shared output → state update helper.
 *
 * Default: every node writes its raw result under `state.outputs.<nodeId>`.
 * (LangGraph forbids a channel name equal to a node id, so we use a reserved
 * `outputs` object channel keyed by node id. Each write replaces that node's
 * whole previous result.)
 * Optional `to` / `map` are projections, written alongside the raw result
 * unless `raw: false`. `none` opts out entirely.
 */

import { renderDeep } from "@flowgraph/expr";
import type { OutputMapping } from "@flowgraph/spec";

/** Reserved channel holding per-node results: `state.outputs.<nodeId>`. */
export const OUTPUTS_CHANNEL = "outputs";

export function isOutputNone(output: unknown): boolean {
  return output === "none";
}

/**
 * Whether the raw result is kept under `state.outputs.<nodeId>`: always, unless
 * the mapping is `none` or sets `raw: false` next to a `to` / `map` projection.
 */
export function keepsRawOutput(output: unknown): boolean {
  if (isOutputNone(output)) return false;
  if (output == null || typeof output !== "object" || Array.isArray(output)) return true;
  return (output as { raw?: unknown }).raw !== false;
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
 * - `"none"` → `{}`
 * - `{ to }` and/or `{ map }` → those writes plus the outputs slug
 * - `{ to } / { map }` with `raw: false` → only those writes
 */
export function applyOutput(
  output: OutputMapping | undefined,
  rawResult: unknown,
  opts: ApplyOutputOpts,
): Record<string, unknown> {
  if (isOutputNone(output)) return {};

  const update: Record<string, unknown> = keepsRawOutput(output)
    ? { [OUTPUTS_CHANNEL]: { [opts.nodeId]: rawResult } }
    : {};

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
