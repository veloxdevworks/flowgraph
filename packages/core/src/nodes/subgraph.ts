/**
 * Built-in node type: `subgraph`
 *
 * Embeds another graph as a single node. `stateMap.in` projects parent state
 * into the child's channels (child ← parent). `stateMap.out` projects child
 * results back (parent ← child). With no `stateMap.out`, channels that share
 * a name merge, and the parent's reducer combines only the child's new values.
 *
 * Nested HITL: the child graph is invoked with the parent's LangGraph RunnableConfig
 * so interrupts propagate to the parent checkpoint (see LangGraph subgraph docs).
 *
 * Nested events: child node events are forwarded onto the parent EventBus with
 * `scope.parentSpanId` set to this subgraph node's id, so UIs can visualize
 * nested run scope.
 */

import * as path from "node:path";
import { z } from "zod";
import {
  compileChannelContract,
  ContractSchemaError,
  SubgraphWithSchema,
  type GraphSpec,
  type InputField,
  type OutputField,
} from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { BaseStore } from "@langchain/langgraph";
import { graphProviderList } from "../providers/registry.js";
import { mediaProviderList } from "../media/registry.js";
import { MEMORY_RUNTIME, type MemoryRuntime } from "../memory/runtime.js";
import type { NodeRunContext } from "../context.js";
import { assertSubgraphFileAllowed, isReservedChannel, nodePolicyOf, withoutReservedKeys } from "../node-policy.js";
import { childRunConfig } from "../providers/replay-cache.js";
import type { EventBus, FlowgraphEvent } from "../events.js";
import { ONCE_CHANNEL } from "../runtime/state-annotation.js";
import { ensureDeclaredOutputChannels } from "../runtime/validate-graph.js";
import { InputValidationError, resolveAndValidateInput } from "../inputs.js";
import { subgraphHostOptions } from "../runtime/subgraph-host-context.js";
import { applyOutput, isOutputNone } from "./output.js";
import {
  projectExplicitOutput,
  projectMatchingOutput,
  projectSubgraphInput,
  type ChannelMergeDef,
} from "./subgraph-merge.js";

const configSchema = SubgraphWithSchema;
type Config = z.infer<typeof configSchema>;

type NodeCtx = NodeRunContext & {
  _input?: unknown;
  _lgConfig?: import("@langchain/langgraph").LangGraphRunnableConfig;
};

interface ChildSpecInfo {
  spec: GraphSpec;
  /** Directory `uses:` refs inside the child resolve against. */
  cwd: string;
  /** Child channels after output targets are declared, used to seed matching inputs. */
  channels: string[];
  /** Reducer/type of each child channel, including auto-declared targets. */
  channelDefs: Record<string, ChannelMergeDef>;
  /** The child's declared run parameters: its call contract for what goes in. */
  inputs: InputField[];
  /** The child's declared results: its call contract for what comes back. Empty when it declares none. */
  outputs: OutputField[];
}

interface EmbeddedChild extends Omit<ChildSpecInfo, "spec" | "cwd"> {
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

  build(buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const uses = String(nodeSpec["uses"] ?? "");
    const inlineSpec = isInlineGraphSpec(nodeSpec["spec"]) ? nodeSpec["spec"] : undefined;
    const parentNodeId = String(nodeSpec["id"] ?? (uses || "subgraph"));
    const remote = buildCtx.remote;
    let childPromise: Promise<EmbeddedChild> | undefined;
    let remoteChildPromise: Promise<ChildSpecInfo> | undefined;

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

        // Placed on a worker (ADR-0020): the child is not compiled here. Only its spec and channel
        // definitions are needed; seeding and merge-back below are the in-process ones.
        let child: Pick<ChildSpecInfo, "channels" | "channelDefs" | "inputs" | "outputs">;
        let embedded: EmbeddedChild | undefined;
        let remoteSpec: GraphSpec | undefined;
        if (remote) {
          remoteChildPromise ??= loadRemoteChild(uses, inlineSpec, parentNodeId, ctx);
          const info = await remoteChildPromise;
          child = info;
          remoteSpec = info.spec;
        } else {
          childPromise ??= loadChild(uses, inlineSpec, parentNodeId, ctx.events, ctx);
          embedded = await childPromise;
          child = embedded;
        }

        const nodeInput = nodeCtx._input ?? {};
        if (typeof nodeInput !== "object" || Array.isArray(nodeInput)) {
          throw subgraphError(
            "SUBGRAPH_INPUT_INVALID",
            `subgraph "${label}": input must be an object whose keys are the child's inputs (got ${Array.isArray(nodeInput) ? "an array" : typeof nodeInput})`,
          );
        }
        const parentChannels = (ctx.config.channels ?? {}) as Record<string, ChannelMergeDef>;
        const projected = projectSubgraphInput({
          stateMapIn: config.stateMap?.in,
          parentState: state,
          nodeInput: nodeInput as Record<string, unknown>,
          childChannels: child.channels,
          resolve: (ref) => resolveRef(ref, state, nodeInput as Record<string, unknown>, ctx),
        });
        const { seeds } = projected;
        const childInput = checkChildInput(label, child, projected.input, [
          ...Object.keys(config.stateMap?.in ?? {}),
          ...Object.keys(nodeInput),
        ]);

        ctx.emit("node.output", { subgraph: label, input: Object.keys(childInput) });

        // The child starts from its own engine channels (none of the parent's,
        // none from `input`), and its run scope sits under this node.
        // Placed: `remote.execute` stages the artifacts in `childInput` to the worker, and what flows
        // back into the parent is staged out below (ADR-0020 section 10).
        const childState = remote
          ? await remote.execute({ ctx, spec: remoteSpec!, input: withoutReservedKeys(childInput) })
          : await embedded!.invoke(withoutReservedKeys(childInput), childRunConfig(lgConfig, ctx.nodeId));
        const clean = exposedChildState(label, child.outputs, stripSubgraphState(childState));
        // Only what flows back into the parent is fetched from the worker (artifact records in it).
        const flowBack = async (update: Record<string, unknown>): Promise<Record<string, unknown>> =>
          remote ? remote.stageOut(ctx, update) : update;

        // Explicit parent ← child mapping. The parent's reducer sees a delta
        // only when this parent channel is the one that seeded the child value.
        if (config.stateMap?.out) {
          return {
            update: await flowBack(
              projectExplicitOutput({
                out: config.stateMap.out,
                childState: clean,
                seeds,
                parentChannels,
                childChannelDefs: child.channelDefs,
                resolve: (ref) => resolveRef(ref, clean, {}, ctx),
              }),
            ),
          };
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
            update: await flowBack(
              applyOutput(config.output, clean, {
                nodeId: parentNodeId,
                scope: { result: clean, ...clean },
              }),
            ),
          };
        }

        // No explicit mapping: merge channels that share a name. Changed child-only
        // channels stay on the update so `map` can unwrap them; the parent graph
        // drops any key it did not declare.
        return {
          update: await flowBack(
            projectMatchingOutput({
              childState: clean,
              seeds,
              parentChannels,
              childChannelDefs: child.channelDefs,
            }),
          ),
        };
      },
    };
  },
});

/** Load the child graph and its channel definitions without compiling it. */
async function loadChildSpec(
  uses: string,
  inlineSpec: GraphSpec | undefined,
  parentNodeId: string,
  ctx: NodeRunContext,
): Promise<ChildSpecInfo> {
  let spec: GraphSpec;
  let cwd = ctx.config.graphDir ?? ctx.workspace;
  if (inlineSpec) {
    spec = inlineSpec;
  } else {
    assertSubgraphFileAllowed(nodePolicyOf(ctx), uses, `subgraph node "${parentNodeId}"`);
    const { loadGraph } = await import("../loader.js");
    const aliases =
      (ctx.config as { subgraphs?: Record<string, string> }).subgraphs ?? {};
    const ref = aliases[uses] ?? uses;

    const loaded = await loadGraph(ref, { cwd });
    if (!loaded.spec) {
      throw new Error(
        `subgraph: could not load "${uses}" (${ref}): ${loaded.diagnostics.map((d) => d.message).join("; ")}`,
      );
    }
    spec = loaded.spec;
    cwd = path.dirname(path.resolve(cwd, ref));
  }

  const declared = ensureDeclaredOutputChannels(spec);
  const channelDefs: Record<string, ChannelMergeDef> = {};
  for (const [name, def] of Object.entries(declared.state?.channels ?? {})) {
    channelDefs[name] = {
      ...(def.type ? { type: def.type } : {}),
      ...(def.reducer ? { reducer: def.reducer } : {}),
    };
  }
  return {
    spec,
    cwd,
    channels: Object.keys(channelDefs),
    channelDefs,
    inputs: Array.isArray(spec.inputs) ? spec.inputs : [],
    outputs: Array.isArray(spec.outputs) ? spec.outputs : [],
  };
}

/** The child as a worker receives it: `uses:` children (and theirs) inlined as `spec:`. */
async function loadRemoteChild(
  uses: string,
  inlineSpec: GraphSpec | undefined,
  parentNodeId: string,
  ctx: NodeRunContext,
): Promise<ChildSpecInfo> {
  const info = await loadChildSpec(uses, inlineSpec, parentNodeId, ctx);
  const { bundleGraphForRemote } = await import("../runtime/bundle-graph.js");
  // Blockers (shell, skills, imports) describe what a generic server cannot run; the worker chosen
  // for this node was preflighted for exactly this spec, so they are not refused here.
  const bundled = await bundleGraphForRemote(info.spec, { cwd: info.cwd });
  return { ...info, spec: bundled.spec };
}

async function loadChild(
  uses: string,
  inlineSpec: GraphSpec | undefined,
  parentNodeId: string,
  parentEvents: EventBus,
  ctx: NodeRunContext,
): Promise<EmbeddedChild> {
  const { compileGraphForEmbedding, resolveGraphWorkspace } = await import("../compiler.js");
  const { spec, cwd, channels, channelDefs, inputs, outputs } = await loadChildSpec(uses, inlineSpec, parentNodeId, ctx);

  const forwardSink = (event: FlowgraphEvent) => {
    parentEvents.emit(event.type, event.data, {
      ...event.scope,
      parentSpanId: parentNodeId,
    });
  };

  const { compiledLg } = await compileGraphForEmbedding(spec, {
    ...subgraphHostOptions(ctx),
    cwd,
    workspace: resolveGraphWorkspace(spec, ctx.workspace),
    sinks: [forwardSink],
    store: childStore(spec, ctx),
    ...(nodePolicyOf(ctx) ? { nodePolicy: nodePolicyOf(ctx)! } : {}),
    // The parent's own providers, so the child answers with the same ones.
    providers: graphProviderList(ctx),
    mediaProviders: mediaProviderList(ctx),
    ...(parentMemoryRuntime(ctx) ? { memory: parentMemoryRuntime(ctx)! } : { memory: "ephemeral" as const }),
  });

  return {
    async invoke(input, lgConfig) {
      const result = ((await compiledLg.invoke(
        input as Parameters<typeof compiledLg.invoke>[0],
        lgConfig as Parameters<typeof compiledLg.invoke>[1],
      )) ?? {}) as Record<string, unknown>;
      return result;
    },
    channels,
    channelDefs,
    inputs,
    outputs,
  };
}

/**
 * The child shares the parent's long-term store (one store per run tree), so memory
 * written by a subgraph is visible to the parent and vice versa.
 */
function childStore(_spec: GraphSpec, ctx: NodeRunContext): BaseStore | "none" {
  return ctx.store ?? "none";
}

/**
 * Subgraphs share the root graph's memory runtime: the same backend, identity,
 * graph name (scopes are keyed by the root graph) and per-thread bindings.
 */
function parentMemoryRuntime(ctx: NodeRunContext): MemoryRuntime | undefined {
  return (ctx as unknown as Record<symbol, unknown>)[MEMORY_RUNTIME] as MemoryRuntime | undefined;
}

/**
 * The child's state without reserved channels (every `__` name: `__once`,
 * `__agentReplay`, `__services`, `__worktrees`, `__interrupt__`, ...). Those
 * are the child's own bookkeeping; letting them flow into the parent would
 * let a child write the parent's engine channels.
 */
function stripSubgraphState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k === ONCE_CHANNEL || isReservedChannel(k)) continue;
    out[k] = v;
  }
  return out;
}

function subgraphError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false });
}

/**
 * The call boundary, inbound: what the parent hands the child is checked against the child's
 * declared `inputs` (defaults applied, required and type checks) and against its channels, so a
 * key the child does not declare is an error instead of being dropped. A same-name parent channel
 * that is copied in implicitly and holds `null` means "no value yet" and is not checked.
 */
function checkChildInput(
  label: string,
  child: Pick<ChildSpecInfo, "channels" | "inputs">,
  input: Record<string, unknown>,
  explicitKeys: readonly string[],
): Record<string, unknown> {
  const explicit = new Set(explicitKeys);
  const checked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null && !explicit.has(key)) continue;
    checked[key] = value;
  }
  try {
    return { ...input, ...resolveAndValidateInput(child.inputs, withoutReservedKeys(checked), new Set(child.channels)) };
  } catch (err) {
    if (!(err instanceof InputValidationError)) throw err;
    throw new InputValidationError(
      err.issues.map((issue) => `subgraph "${label}": ${issue}`),
      err.errors,
    );
  }
}

/**
 * The call boundary, outbound: each declared output must be present (unless `required: false`)
 * and match its contract, and only declared outputs go back to the parent. A child that declares
 * none returns its whole state.
 */
function exposedChildState(
  label: string,
  outputs: readonly OutputField[],
  state: Record<string, unknown>,
): Record<string, unknown> {
  if (outputs.length === 0) return state;
  const exposed: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const field of outputs) {
    const value = state[field.key];
    if (value === undefined || value === null) {
      if (field.required !== false) problems.push(`output "${field.key}" was not produced`);
      if (value !== undefined) exposed[field.key] = value;
      continue;
    }
    let check;
    try {
      check = compileChannelContract({ type: field.type, schema: field.schema });
    } catch (err) {
      if (err instanceof ContractSchemaError) {
        throw subgraphError("SUBGRAPH_OUTPUT_INVALID", `subgraph "${label}": output "${field.key}": invalid schema: ${err.message}`);
      }
      throw err;
    }
    const problem = check?.(value);
    if (problem) problems.push(`output "${field.key}" does not match its contract: ${problem}`);
    exposed[field.key] = value;
  }
  if (problems.length > 0) {
    throw subgraphError("SUBGRAPH_OUTPUT_INVALID", `subgraph "${label}": ${problems.join("; ")}`);
  }
  return exposed;
}

function resolveRef(
  ref: unknown,
  primary: Record<string, unknown>,
  input: Record<string, unknown>,
  ctx: NodeRunContext,
): unknown {
  if (typeof ref !== "string") return ref;
  // stateMap refs never read reserved channels, on either side.
  if (ref.includes("{{")) {
    const visible = stripSubgraphState(primary);
    return renderDeep(ref, { state: visible, result: visible, input, config: ctx.config, run: ctx.meta });
  }
  if (isReservedChannel(ref.trim())) return undefined;
  return primary[ref];
}
