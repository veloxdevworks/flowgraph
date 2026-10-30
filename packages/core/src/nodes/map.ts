/**
 * Built-in node type: `map`
 *
 * Fan-out is expanded at compile time into a dispatcher (LangGraph `Send` per
 * item), a worker, and a join that restores `collect.to` order. This module
 * still registers the type and runs a single inner item for the worker.
 */

import { z } from "zod";
import { MapWithSchema } from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import { registry, defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { assertNodeTypeAllowed, nodePolicyOf } from "../node-policy.js";
import { applyOutput } from "./output.js";
import { RESERVED_STATE_CHANNELS } from "../runtime/state-annotation.js";

const configSchema = MapWithSchema;
type Config = z.infer<typeof configSchema>;

export const mapNode = defineNode<Config>({
  type: "map",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { interruptible: true },

  build(): CompiledNode {
    return {
      contract: {},
      capabilities: { interruptible: true },
      async run(): Promise<NodeResult> {
        throw new Error("map node was not expanded at compile time (internal error).");
      },
    };
  },
});

export interface MapTask {
  mapId: string;
  index: number;
  item: unknown;
  as: string;
  count: number;
}

export function mapSyntheticIds(mapId: string): { workerId: string; joinId: string } {
  const safe = mapId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return { workerId: `mapw_${safe}`, joinId: `mapj_${safe}` };
}

/** Run the inner node for one mapped item. */
export async function runMapItem(
  buildCtx: BuildContext,
  mapId: string,
  config: Config,
  state: Record<string, unknown>,
  ctx: NodeRunContext,
  task: MapTask,
): Promise<unknown> {
  const parentInput = (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
  const baseScope = { state, input: parentInput, config: ctx.config, run: ctx.meta };
  const as = config.as;
  const itemScope = { ...baseScope, item: { [as]: task.item } };
  const innerSpec = config.node as Record<string, unknown>;
  const innerType = String(innerSpec["type"] ?? "");
  assertNodeTypeAllowed(nodePolicyOf(ctx), innerType, `map node "${mapId}" inner node`);
  const factory = registry.get(innerType);
  if (!factory) {
    throw new Error(`map node "${mapId}": inner node type "${innerType}" is not registered.`);
  }

  const originalWith = (innerSpec["with"] as Record<string, unknown> | undefined) ?? {};
  const parsed = factory.configSchema.safeParse(originalWith);
  if (!parsed.success) {
    throw new Error(
      `map node inner config error: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    );
  }
  const renderedWith = renderDeep(originalWith, itemScope) as Record<string, unknown>;
  const renderedInput = innerSpec["input"]
    ? (renderDeep(innerSpec["input"], itemScope) as Record<string, unknown>)
    : {};
  const mergedConfig = { ...(parsed.data as Record<string, unknown>), ...renderedWith };
  const innerNodeSpec = { ...innerSpec, with: mergedConfig };
  const compiledInner = factory.build(buildCtx, innerNodeSpec, mergedConfig);

  const childCtx: NodeRunContext & { _input: Record<string, unknown> } = {
    ...ctx,
    nodeId: `${mapId}[${task.index}]`,
    nodeType: innerType,
    _input: renderedInput,
    render: (tpl: string, extra: Record<string, unknown> = {}) =>
      renderDeep(tpl, { ...itemScope, ...extra }),
  };

  const res = await compiledInner.run(state, childCtx);
  return unwrapUpdate(res);
}

const RESERVED_CHANNEL_SET: ReadonlySet<string> = new Set<string>(RESERVED_STATE_CHANNELS);

/**
 * Reduce a NodeResult to a single collectable value.
 * Prefers an explicit `to`/`map` channel over the reserved `outputs` slug.
 */
export function unwrapUpdate(res: NodeResult): unknown {
  const raw = "update" in res ? res.update : "command" in res ? (res.command.update ?? {}) : {};
  // Reserved bookkeeping channels (e.g. the agent's __agentReplay clear) are not results.
  const update = Object.fromEntries(Object.entries(raw).filter(([k]) => !RESERVED_CHANNEL_SET.has(k)));
  const keys = Object.keys(update);

  const nonOutputs = keys.filter((k) => k !== "outputs");
  if (nonOutputs.length === 1) return update[nonOutputs[0]!];
  if (nonOutputs.length > 1) return update;

  if (keys.length === 1 && keys[0] === "outputs") {
    const nested = update["outputs"];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedKeys = Object.keys(nested as Record<string, unknown>);
      if (nestedKeys.length === 1) return (nested as Record<string, unknown>)[nestedKeys[0]!];
    }
    return nested;
  }

  if (keys.length === 1) return update[keys[0]!];
  return update;
}

export function collectMapResults(
  config: Config,
  bag: Array<{ i: number; v: unknown }>,
  nodeId: string,
  baseScope: Record<string, unknown>,
): Record<string, unknown> {
  const ordered = [...bag].sort((a, b) => a.i - b.i).map((x) => x.v);
  if (
    config.collect != null &&
    typeof config.collect === "object" &&
    config.collect.map != null &&
    !config.collect.none
  ) {
    const update = applyOutput(
      { to: config.collect.to, none: config.collect.none },
      ordered,
      { nodeId, scope: baseScope },
    );
    for (const [channel, expr] of Object.entries(config.collect.map)) {
      if (!channel.trim()) continue;
      update[channel] = ordered.map((r) => renderDeep(expr, { result: r, item: r }));
    }
    return update;
  }
  return applyOutput(config.collect, ordered, { nodeId, scope: baseScope });
}
