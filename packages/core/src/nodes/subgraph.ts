/**
 * Built-in node type: `subgraph`
 *
 * Embeds another graph as a single node. `stateMap.in` projects parent state
 * into the child's channels; `stateMap.out` projects child results back.
 */

import { z } from "zod";
import { SubgraphWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";

const configSchema = SubgraphWithSchema;
type Config = z.infer<typeof configSchema>;

interface CompiledChild {
  run(opts: { input?: Record<string, unknown>; threadId?: string }): Promise<{ status: string; state: Record<string, unknown>; error?: Error }>;
}

export const subgraphNode = defineNode<Config>({
  type: "subgraph",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: {},

  build(_buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const uses = String(nodeSpec["uses"] ?? "");
    let childPromise: Promise<CompiledChild> | undefined;

    return {
      contract: {},
      capabilities: {},

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        childPromise ??= loadChild(uses, ctx);
        const child = await childPromise;

        // Project parent state into child input
        const nodeInput =
          (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
        let childInput: Record<string, unknown>;
        if (config.stateMap?.in) {
          childInput = {};
          for (const [childChannel, parentExpr] of Object.entries(config.stateMap.in)) {
            // value may be a plain channel name or a template
            childInput[childChannel] = resolveRef(parentExpr, state, nodeInput, ctx);
          }
        } else {
          childInput = { ...state, ...nodeInput };
        }

        ctx.emit("node.output", { subgraph: uses, input: Object.keys(childInput) });

        const result = await child.run({ input: childInput });
        if (result.status === "error") {
          throw new Error(`subgraph "${uses}" failed: ${result.error?.message ?? "unknown error"}`);
        }
        if (result.status === "interrupted") {
          throw new Error(`subgraph "${uses}" interrupted; nested HITL is not yet supported.`);
        }

        // Project child results back into parent channels
        if (config.stateMap?.out) {
          const update: Record<string, unknown> = {};
          for (const [parentChannel, childExpr] of Object.entries(config.stateMap.out)) {
            update[parentChannel] = resolveRef(childExpr, result.state, {}, ctx);
          }
          return { update };
        }

        if (config.output && "to" in config.output) {
          return { update: { [config.output.to]: result.state } };
        }
        if (config.output && "map" in config.output) {
          const update: Record<string, unknown> = {};
          for (const [channel, expr] of Object.entries(config.output.map)) {
            update[channel] = renderDeep(expr, { result: result.state, ...result.state });
          }
          return { update };
        }
        return { update: result.state };
      },
    };
  },
});

async function loadChild(uses: string, ctx: NodeRunContext): Promise<CompiledChild> {
  const { loadGraph } = await import("../loader.js");
  const { compileGraph } = await import("../compiler.js");

  // Resolve alias → path (from imports) or treat as a relative path.
  const aliases =
    (ctx.config as { subgraphs?: Record<string, string> }).subgraphs ?? {};
  const ref = aliases[uses] ?? uses;

  const { spec, diagnostics } = await loadGraph(ref, { cwd: ctx.workspace });
  if (!spec) {
    throw new Error(`subgraph: could not load "${uses}" (${ref}): ${diagnostics.map((d) => d.message).join("; ")}`);
  }
  const compiled = await compileGraph(spec, { cwd: ctx.workspace, checkpointer: "none" });
  return compiled as unknown as CompiledChild;
}

/**
 * A stateMap value may be a bare channel name (e.g. "repo") or a template
 * (e.g. "{{ state.repo }}"). Resolve accordingly.
 */
function resolveRef(
  ref: unknown,
  primary: Record<string, unknown>,
  input: Record<string, unknown>,
  ctx: NodeRunContext,
): unknown {
  // Already-resolved concrete value (e.g. pre-rendered by an enclosing map).
  if (typeof ref !== "string") return ref;
  if (ref.includes("{{")) {
    return renderDeep(ref, { state: primary, result: primary, input, config: ctx.config, run: ctx.meta });
  }
  // bare name → read from the primary object
  return primary[ref];
}
