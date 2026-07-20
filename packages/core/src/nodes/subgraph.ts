/**
 * Built-in node type: `subgraph`
 *
 * Embeds another graph as a single node. `stateMap.in` projects parent state
 * into the child's channels; `stateMap.out` projects child results back.
 *
 * Nested HITL: the child graph is invoked with the parent's LangGraph RunnableConfig
 * so interrupts propagate to the parent checkpoint (see LangGraph subgraph docs).
 *
 * Nested events: child node events are forwarded onto the parent EventBus with
 * `scope.parentSpanId` set to this subgraph node's id, so UIs can visualize
 * nested run scope.
 */

import { z } from "zod";
import { SubgraphWithSchema, type GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import type { EventBus, FlowgraphEvent } from "../events.js";
import { ONCE_CHANNEL } from "../runtime/state-annotation.js";
import { applyOutput, isOutputNone } from "./output.js";

const configSchema = SubgraphWithSchema;
type Config = z.infer<typeof configSchema>;

type NodeCtx = NodeRunContext & {
  _input?: Record<string, unknown>;
  _lgConfig?: import("@langchain/langgraph").LangGraphRunnableConfig;
};

interface EmbeddedChild {
  invoke(
    input: Record<string, unknown>,
    lgConfig: import("@langchain/langgraph").LangGraphRunnableConfig,
  ): Promise<Record<string, unknown>>;
}

function isInlineGraphSpec(value: unknown): value is GraphSpec {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

export const subgraphNode = defineNode<Config>({
  type: "subgraph",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { interruptible: true },

  build(_buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const uses = String(nodeSpec["uses"] ?? "");
    const inlineSpec = isInlineGraphSpec(nodeSpec["spec"]) ? nodeSpec["spec"] : undefined;
    const parentNodeId = String(nodeSpec["id"] ?? (uses || "subgraph"));
    let childPromise: Promise<EmbeddedChild> | undefined;

    return {
      contract: {},
      capabilities: { interruptible: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const nodeCtx = ctx as NodeCtx;
        const lgConfig = nodeCtx._lgConfig;
        const label = uses || parentNodeId;
        if (!lgConfig) {
          throw new Error(`subgraph "${label}": missing LangGraph runtime config (internal error).`);
        }

        childPromise ??= loadChild(uses, inlineSpec, parentNodeId, ctx.events, ctx);
        const child = await childPromise;

        const nodeInput = nodeCtx._input ?? {};
        let childInput: Record<string, unknown>;
        if (config.stateMap?.in) {
          childInput = {};
          for (const [childChannel, parentExpr] of Object.entries(config.stateMap.in)) {
            childInput[childChannel] = resolveRef(parentExpr, state, nodeInput, ctx);
          }
        } else {
          childInput = { ...state, ...nodeInput };
        }

        ctx.emit("node.output", { subgraph: label, input: Object.keys(childInput) });

        const childState = await child.invoke(childInput, lgConfig);
        const clean = stripSubgraphState(childState);

        if (config.stateMap?.out) {
          const update: Record<string, unknown> = {};
          for (const [parentChannel, childExpr] of Object.entries(config.stateMap.out)) {
            update[parentChannel] = resolveRef(childExpr, clean, {}, ctx);
          }
          return { update };
        }

        // Opt out of writing anything into the parent.
        if (isOutputNone(config.output)) {
          return { update: {} };
        }

        // Explicit to/map: slug + projections (not a full child-state merge).
        if (
          config.output != null &&
          typeof config.output === "object" &&
          (config.output.to != null || config.output.map != null)
        ) {
          return {
            update: applyOutput(config.output, clean, {
              nodeId: parentNodeId,
              scope: { result: clean, ...clean },
            }),
          };
        }

        // Default: merge the child's state into the parent (transparent passthrough).
        return { update: clean };
      },
    };
  },
});

async function loadChild(
  uses: string,
  inlineSpec: GraphSpec | undefined,
  parentNodeId: string,
  parentEvents: EventBus,
  ctx: NodeRunContext,
): Promise<EmbeddedChild> {
  const { compileGraphForEmbedding } = await import("../compiler.js");

  let spec: GraphSpec;
  if (inlineSpec) {
    spec = inlineSpec;
  } else {
    const { loadGraph } = await import("../loader.js");
    const aliases =
      (ctx.config as { subgraphs?: Record<string, string> }).subgraphs ?? {};
    const ref = aliases[uses] ?? uses;

    const loaded = await loadGraph(ref, { cwd: ctx.workspace });
    if (!loaded.spec) {
      throw new Error(
        `subgraph: could not load "${uses}" (${ref}): ${loaded.diagnostics.map((d) => d.message).join("; ")}`,
      );
    }
    spec = loaded.spec;
  }

  const forwardSink = (event: FlowgraphEvent) => {
    parentEvents.emit(event.type, event.data, {
      ...event.scope,
      parentSpanId: parentNodeId,
    });
  };

  const { compiledLg } = await compileGraphForEmbedding(spec, {
    cwd: ctx.workspace,
    sinks: [forwardSink],
  });

  return {
    async invoke(input, lgConfig) {
      const result = ((await compiledLg.invoke(
        input as Parameters<typeof compiledLg.invoke>[0],
        lgConfig as Parameters<typeof compiledLg.invoke>[1],
      )) ?? {}) as Record<string, unknown>;
      return result;
    },
  };
}

function stripSubgraphState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k === ONCE_CHANNEL || k === "__interrupt__") continue;
    out[k] = v;
  }
  return out;
}

function resolveRef(
  ref: unknown,
  primary: Record<string, unknown>,
  input: Record<string, unknown>,
  ctx: NodeRunContext,
): unknown {
  if (typeof ref !== "string") return ref;
  if (ref.includes("{{")) {
    return renderDeep(ref, { state: primary, result: primary, input, config: ctx.config, run: ctx.meta });
  }
  return primary[ref];
}
