/**
 * Built-in node type: `function`
 *
 * Invokes a registered TypeScript function by name.
 */

import { z } from "zod";
import { FunctionWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";

// Function registry separate from the node registry
const fnRegistry = new Map<string, (input: unknown, ctx: NodeRunContext) => Promise<unknown> | unknown>();

export function registerFunction(
  name: string,
  fn: (input: unknown, ctx: NodeRunContext) => Promise<unknown> | unknown,
): void {
  fnRegistry.set(name, fn);
}

export function getRegisteredFunction(name: string) {
  return fnRegistry.get(name);
}

const configSchema = FunctionWithSchema;
type Config = z.infer<typeof configSchema>;

export const functionNode = defineNode<Config>({
  type: "function",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: {},

  build(_ctx: BuildContext, _nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: {},

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const fn = fnRegistry.get(config.fn);
        if (!fn) {
          throw new Error(
            `function node: function "${config.fn}" is not registered. ` +
              `Call registerFunction("${config.fn}", handler) before running the graph.`,
          );
        }

        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
        };

        // Build the function input by rendering templates in config.input
        const input = config.input
          ? (renderDeep(config.input, scope) as Record<string, unknown>)
          : {};

        const result = await fn(input, ctx);

        ctx.emit("node.output", { result });

        // Apply output mapping
        if (!config.output) return { update: {} };
        if ("to" in config.output) {
          return { update: { [config.output.to]: result } };
        }
        if ("map" in config.output) {
          const update: Record<string, unknown> = {};
          for (const [channel, expr] of Object.entries(config.output.map)) {
            const rendered = renderDeep(expr, { result, ...scope });
            update[channel] = rendered;
          }
          return { update };
        }
        return { update: {} };
      },
    };
  },
});
