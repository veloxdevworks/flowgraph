/**
 * Built-in node type: `map`
 *
 * Fan-out over a collection: run an inner node once per item (bounded by
 * `concurrency`), then fan-in the results into a collection channel.
 *
 * Each element is bound under `as` (default "item") so the inner node can
 * reference it via {{ item.<as> }}. All templates in the inner spec are
 * resolved per item before the inner node runs.
 */

import { z } from "zod";
import { MapWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { registry, defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";

const configSchema = MapWithSchema;
type Config = z.infer<typeof configSchema>;

export const mapNode = defineNode<Config>({
  type: "map",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: {},

  build(buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const as = config.as;
    const innerType = String((config.node as Record<string, unknown>)["type"] ?? "");
    const factory = registry.get(innerType);
    if (!factory) {
      throw new Error(`map node "${String(nodeSpec["id"])}": inner node type "${innerType}" is not registered.`);
    }

    return {
      contract: {},
      capabilities: {},

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const parentInput =
          (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
        const baseScope = { state, input: parentInput, config: ctx.config, run: ctx.meta };

        const collection = renderDeep(config.over, baseScope);
        if (!Array.isArray(collection)) {
          throw new Error(`map node "${String(nodeSpec["id"])}": "over" did not evaluate to an array.`);
        }

        ctx.emit("node.output", { map: { over: config.over, count: collection.length, concurrency: config.concurrency } });

        const runItem = async (item: unknown): Promise<unknown> => {
          const itemScope = { ...baseScope, item: { [as]: item } };
          const innerSpec = config.node as Record<string, unknown>;

          // Validate against the *template* form (matches the node's schema),
          // then build with item-resolved concrete values so the inner node
          // sees fully-rendered config (any remaining renders are passthroughs).
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
            nodeId: `${String(nodeSpec["id"])}[item]`,
            _input: renderedInput,
            render: (tpl: string, extra: Record<string, unknown> = {}) =>
              renderDeep(tpl, { ...itemScope, ...extra }),
          };

          const res = await compiledInner.run(state, childCtx);
          return unwrapUpdate(res);
        };

        const results = await runPool(collection, config.concurrency, runItem);

        // Fan-in
        if (config.collect && "to" in config.collect) {
          return { update: { [config.collect.to]: results } };
        }
        if (config.collect && "map" in config.collect) {
          const update: Record<string, unknown> = {};
          for (const [channel, expr] of Object.entries(config.collect.map)) {
            update[channel] = results.map((r) => renderDeep(expr, { result: r, item: r }));
          }
          return { update };
        }
        return { update: { result: results } };
      },
    };
  },
});

/** Reduce a NodeResult to a single collectable value (unwrap single-key updates). */
function unwrapUpdate(res: NodeResult): unknown {
  const update = "update" in res ? res.update : "command" in res ? (res.command.update ?? {}) : {};
  const keys = Object.keys(update);
  if (keys.length === 1) return update[keys[0]!];
  return update;
}

/** Run `fn` over items with at most `concurrency` in flight, preserving order. */
async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}
