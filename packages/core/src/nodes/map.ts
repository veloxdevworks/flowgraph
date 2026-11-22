/**
 * Built-in node type: `map`
 *
 * Fan-out is expanded at compile time into a dispatcher (LangGraph `Send` per
 * item), a worker, and a join that restores `collect.to` order. This module
 * still registers the type and runs a single inner item for the worker.
 */

import { z } from "zod";
import { MapWithSchema } from "@flowgraph/spec";
import { evalGuard, guardExpression, renderDeep } from "@flowgraph/expr";
import type { OutputMapping } from "@flowgraph/spec";
import { registry, defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { assertNodeSpecAllowed, assertNodeTypeAllowed, isReservedChannel, nodePolicyOf, withoutReservedKeys } from "../node-policy.js";
import type { MapMemo } from "../runtime/map-memo.js";
import { applyOutput } from "./output.js";

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
  /** Absent on checkpoints from versions before per-invocation collection bags. */
  round?: string;
  memoGeneration?: number;
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
  memo?: MapMemo,
): Promise<unknown> {
  const parentInput = (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
  const baseScope = { state, input: parentInput, config: ctx.config, run: ctx.meta };
  const as = config.as;
  // The item is bound directly as `{{ <as> }}`; `{{ index }}` is its position in `over`.
  const itemScope = { ...baseScope, [as]: task.item, index: task.index };
  const innerSpec = config.node as Record<string, unknown>;
  const innerType = String(innerSpec["type"] ?? "");
  assertNodeTypeAllowed(nodePolicyOf(ctx), innerType, `map node "${mapId}" inner node`);
  assertNodeSpecAllowed(nodePolicyOf(ctx), innerSpec, `map node "${mapId}" inner node`);
  const factory = (buildCtx.registry ?? registry).get(innerType);
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
  // Output expressions need the completed result as well as the item. Build
  // the inner node with its default raw output, then apply that projection once.
  const { output: rawOutput, ...requestWith } = originalWith;
  const { output: _parsedOutput, ...parsedWith } = parsed.data as Record<string, unknown>;
  const renderedWith = renderDeep(requestWith, itemScope) as Record<string, unknown>;
  const renderedInput = withoutReservedKeys(
    innerSpec["input"] !== undefined ? renderDeep(innerSpec["input"], itemScope) : {},
  ) as Record<string, unknown>;
  // An item whose body `when` is false is skipped: it contributes nothing to the collected results.
  if (typeof innerSpec["when"] === "string" && innerSpec["when"].trim()) {
    if (!evalGuard(guardExpression(innerSpec["when"]), { ...itemScope, input: renderedInput })) {
      ctx.emit("node.skipped", { nodeId: `${mapId}[${task.index}]`, mapId, index: task.index });
      return undefined;
    }
  }
  const renderedSpec = { ...innerSpec, id: ctx.nodeId, with: { ...parsedWith, ...renderedWith } };
  assertNodeSpecAllowed(nodePolicyOf(ctx), renderedSpec, `map node "${mapId}" rendered inner node`);
  const mergedConfig = { ...parsedWith, ...(inertTemplates(renderedWith) as Record<string, unknown>) };
  const innerNodeSpec = { ...innerSpec, id: ctx.nodeId, with: mergedConfig };
  const compiledInner = factory.build(buildCtx, innerNodeSpec, mergedConfig);

  const childCtx: NodeRunContext & { _input: Record<string, unknown> } = {
    ...ctx,
    nodeId: `${mapId}[${task.index}]`,
    nodeType: innerType,
    _input: renderedInput,
    render: (tpl: string, extra: Record<string, unknown> = {}) =>
      renderDeep(tpl, { ...itemScope, ...extra }),
  };

  const invoke = async () => unwrapUpdate(await compiledInner.run(state, childCtx));
  const value = memo
    ? await memo.run({ spec: { ...innerSpec, with: requestWith }, config: mergedConfig, input: renderedInput }, invoke, itemScope, childCtx)
    : await invoke();
  if (rawOutput === undefined) return value;
  const output = typeof rawOutput === "object" && rawOutput !== null
    ? { ...rawOutput, ...("to" in rawOutput ? { to: renderDeep(rawOutput.to, itemScope) } : {}) }
    : rawOutput;
  const projected = applyOutput(output as OutputMapping, value, { nodeId: ctx.nodeId, scope: itemScope });
  if (output && typeof output === "object" && "map" in output && output.map && typeof output.map === "object") {
    // The declared map is the collected record, even when it has one key.
    return Object.fromEntries(Object.keys(output.map).filter(key => key.trim() && !isReservedChannel(key)).map(key => [key, projected[key]]));
  }
  return unwrapUpdate({ update: projected });
}

/**
 * The map renders the inner `with` once, with the item in scope and no
 * `secret`, so `{{ secret.X }}` in a map body renders as null. The inner node
 * then renders its config again with its own scope. Values the map rendered
 * may carry item data, so any string that still contains `{{` becomes a
 * quoted literal that renders to itself. A field the inner node does not
 * render would see the quoted form, so this only touches strings that
 * contain `{{`.
 */
function inertTemplates(value: unknown): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    const quoted = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `{{ "${quoted}" }}`;
  }
  if (Array.isArray(value)) return value.map(inertTemplates);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inertTemplates(v)]));
  }
  return value;
}

/**
 * Reduce a NodeResult to a single collectable value.
 * Prefers an explicit `to`/`map` channel over the reserved `outputs` slug.
 */
export function unwrapUpdate(res: NodeResult): unknown {
  const raw = "update" in res ? res.update : "command" in res ? (res.command.update ?? {}) : {};
  // `__` bookkeeping channels are not results.
  const update = Object.fromEntries(Object.entries(raw).filter(([k]) => !isReservedChannel(k)));
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

/**
 * The join's state update. `collect.to` / `collect.map` are author-chosen
 * channel names, so `__` names are dropped here for every graph: the map
 * node owns no engine channel.
 */
export function collectMapResults(
  config: Config,
  bag: Array<{ i: number; v: unknown }>,
  nodeId: string,
  baseScope: Record<string, unknown>,
): Record<string, unknown> {
  return withoutReservedKeys(collectMapUpdate(config, bag, nodeId, baseScope));
}

function collectMapUpdate(
  config: Config,
  bag: Array<{ i: number; v: unknown }>,
  nodeId: string,
  baseScope: Record<string, unknown>,
): Record<string, unknown> {
  // `undefined` is a skipped item (its body `when` was false): nothing was collected for it.
  const ordered = [...bag].sort((a, b) => a.i - b.i).filter((x) => x.v !== undefined).map((x) => x.v);
  if (
    config.collect != null &&
    typeof config.collect === "object" &&
    config.collect.map != null
  ) {
    const update = applyOutput(
      { to: config.collect.to, ...(config.collect.raw !== undefined ? { raw: config.collect.raw } : {}) },
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
