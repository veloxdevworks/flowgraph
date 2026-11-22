/**
 * Node Registry — maps type strings to NodeFactory implementations.
 * Third-party node plugins register factories here.
 */

import { z } from "zod";
import { zodToConfigJsonSchema, type Diagnostic, type GraphSpec } from "@flowgraph/spec";
import type { ContextConfigInput } from "./context/types.js";
import type { NodeRunContext } from "./context.js";
import type { NodePolicy } from "./node-policy.js";

export interface NodeContract {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export type NodeCapabilities = {
  sideEffecting?: boolean;
  streaming?: boolean;
  interruptible?: boolean;
  routing?: boolean;
  /** Ends execution deliberately, without requiring an outgoing END edge. */
  terminal?: boolean;
  /**
   * The node stops its work when `ctx.signal` aborts for a node `timeout`, and undoes nothing a
   * retry needs. Without either timeout-signal capability, `ctx.signal` is the run's
   * own and aborting it means the run was cancelled, so a node may treat it as
   * permission to cancel paid work or kill what it started.
   */
  stopsOnTimeout?: boolean;
  /**
   * Receive an attempt's timeout signal without waiting for the entire invocation
   * to settle. The node must guard work that ignores cancellation before retrying.
   */
  receivesTimeoutSignal?: boolean;
};

export type NodeResult =
  | { update: Record<string, unknown> }
  | { command: { goto?: string | string[]; update?: Record<string, unknown> } }
  | { interrupt: { reason: string; payload?: unknown } };

export interface CompiledNode {
  contract: NodeContract;
  capabilities: NodeCapabilities;
  run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult>;
}

export interface BuildContext {
  graphName: string;
  /**
   * Set when this node was placed on a remote worker (ADR-0020). Only `subgraph` reads it:
   * it replaces the in-process child run with a dispatch, keeping its state seeding and merge.
   */
  remote?: import("./placement/remote.js").RemoteNodeExecutor;
  /** `runtime.worktrees.root` (raw; resolved against the run workspace). */
  worktreeRoot?: string;
  resolveSkill?: (uses: string) => Promise<unknown>;
  resolveSubgraph?: (uses: string) => Promise<unknown>;
  /** `runtime.context`: graph-wide context budget defaults for agent nodes. */
  contextDefaults?: ContextConfigInput;
  /** History channels that more than one agent in this graph uses (with.context.history). */
  sharedHistoryChannels?: ReadonlySet<string>;
  /** Wiring for node-as-tool execution, populated by the compiler. */
  toolWiring?: {
    invokeNode?: (
      id: string,
      args: Record<string, unknown>,
      ctx: NodeRunContext,
      state?: Record<string, unknown>,
    ) => Promise<unknown>;
    /** Look up description/schema for a sibling node exposed as a tool. */
    resolveToolMeta?: (nodeId: string) => {
      description?: string;
      schema?: Record<string, unknown>;
    } | undefined;
  };
}

/**
 * Display metadata a node type carries so UIs can list it and render a form
 * without bespoke code (ADR-0017). All fields optional.
 */
export interface NodeUiMeta {
  label?: string;
  description?: string;
  /** Palette group, e.g. "media". */
  category?: string;
  /** Lucide icon name, e.g. "image", "box". */
  icon?: string;
  /** CSS color for the node accent. */
  color?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface NodeFactory<Config = any> {
  type: string;
  configSchema: z.ZodType<Config>;
  capabilities: NodeCapabilities;
  /** Display metadata for palettes and generic inspectors. */
  ui?: NodeUiMeta;
  build(ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode;
}

export type ReducerFn = (current: unknown, incoming: unknown) => unknown;

export interface RunEndHookContext {
  spec: GraphSpec;
  threadId: string;
  state?: Record<string, unknown> | undefined;
  policy?: NodePolicy | undefined;
}

export interface HydrateHookContext {
  spec: GraphSpec;
  threadId: string;
  snapshotValues?: Record<string, unknown> | undefined;
  nodePolicy?: NodePolicy | undefined;
}

export interface CompileContextHookInput {
  spec: GraphSpec;
  opts: Record<string, unknown>;
  contextBag: Record<symbol, unknown>;
}

export interface RunLifecycleHooks {
  onRunEnd?: (ctx: RunEndHookContext) => Promise<void>;
  onHydrate?: (ctx: HydrateHookContext) => Promise<void>;
}

export type GraphValidatorFn = (spec: GraphSpec) => Diagnostic[];
export type ToolInvokeCheckFn = (nodeSpec: Record<string, unknown>) => string | undefined;
export type CompileContextHookFn = (input: CompileContextHookInput) => void;
export type ProviderSecretResolverFn = (cfg: Record<string, unknown>) => string | undefined;
export type PreflightNodeCheckFn = (node: { id?: string; type?: string; with?: unknown }, path: string, cwd: string) => Promise<Diagnostic[]>;

class Registry {
  private factories = new Map<string, NodeFactory>();
  private reducers = new Map<string, ReducerFn>();
  private validators = new Map<string, { fn: GraphValidatorFn; compile: boolean }>();
  private toolInvokeChecks = new Map<string, ToolInvokeCheckFn>();
  private runLifecycles = new Map<string, RunLifecycleHooks>();
  private compileContexts = new Map<string, CompileContextHookFn>();
  private subgraphSymbols = new Set<symbol>();
  private providerSecretResolvers = new Map<string, ProviderSecretResolverFn>();
  private preflightChecks = new Map<string, PreflightNodeCheckFn>();

  register(factory: NodeFactory): void {
    if (this.factories.has(factory.type)) {
      throw new Error(`Node type "${factory.type}" is already registered`);
    }
    this.factories.set(factory.type, factory);
  }

  get(type: string): NodeFactory | undefined {
    return this.factories.get(type);
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  types(): string[] {
    return [...this.factories.keys()];
  }

  registerReducer(name: string, fn: ReducerFn): void {
    if (this.reducers.has(name)) {
      throw new Error(`Reducer "${name}" is already registered`);
    }
    this.reducers.set(name, fn);
  }

  getReducer(name: string): ReducerFn | undefined {
    return this.reducers.get(name);
  }

  registerValidator(id: string, fn: GraphValidatorFn, opts: { compile?: boolean } = {}): void {
    this.validators.set(id, { fn, compile: opts.compile ?? false });
  }

  runValidators(spec: GraphSpec): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const { fn } of this.validators.values()) out.push(...fn(spec));
    return out;
  }

  runCompileValidators(spec: GraphSpec): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const { fn, compile } of this.validators.values()) {
      if (compile) out.push(...fn(spec));
    }
    return out;
  }

  registerToolInvokeCheck(id: string, fn: ToolInvokeCheckFn): void {
    this.toolInvokeChecks.set(id, fn);
  }

  checkToolInvoke(nodeSpec: Record<string, unknown> | undefined): string | undefined {
    if (!nodeSpec) return undefined;
    for (const fn of this.toolInvokeChecks.values()) {
      const msg = fn(nodeSpec);
      if (msg) return msg;
    }
    return undefined;
  }

  registerRunLifecycle(id: string, hooks: RunLifecycleHooks): void {
    this.runLifecycles.set(id, hooks);
  }

  async runEndHooks(ctx: RunEndHookContext): Promise<void> {
    for (const { onRunEnd } of this.runLifecycles.values()) {
      if (onRunEnd) await onRunEnd(ctx);
    }
  }

  async runHydrateHooks(ctx: HydrateHookContext): Promise<void> {
    for (const { onHydrate } of this.runLifecycles.values()) {
      if (onHydrate) await onHydrate(ctx);
    }
  }

  registerCompileContext(id: string, fn: CompileContextHookFn): void {
    this.compileContexts.set(id, fn);
  }

  applyCompileContexts(input: CompileContextHookInput): void {
    for (const fn of this.compileContexts.values()) fn(input);
  }

  registerSubgraphContextSymbol(sym: symbol): void {
    this.subgraphSymbols.add(sym);
  }

  subgraphContextSymbols(): symbol[] {
    return [...this.subgraphSymbols];
  }

  registerProviderSecretResolver(kind: string, fn: ProviderSecretResolverFn): void {
    this.providerSecretResolvers.set(kind, fn);
  }

  resolveProviderDefaultSecret(cfg: Record<string, unknown>): string | undefined {
    const kind = typeof cfg.kind === "string" ? cfg.kind : undefined;
    if (!kind) return undefined;
    return this.providerSecretResolvers.get(kind)?.(cfg);
  }

  registerPreflightCheck(nodeType: string, fn: PreflightNodeCheckFn): void {
    this.preflightChecks.set(nodeType, fn);
  }

  async runPreflightChecks(
    node: { id?: string; type?: string; with?: unknown },
    path: string,
    cwd: string,
  ): Promise<Diagnostic[]> {
    const fn = typeof node.type === "string" ? this.preflightChecks.get(node.type) : undefined;
    return fn ? fn(node, path, cwd) : [];
  }
}

export const registry = new Registry();

/** Helper for defining a node factory with proper typing */
export function defineNode<Config>(factory: NodeFactory<Config>): NodeFactory<Config> {
  return factory;
}

/** What a UI needs to list a node type and render an inspector for it. */
export interface NodeTypeDescriptor {
  type: string;
  label: string;
  description?: string;
  category: string;
  icon?: string;
  color?: string;
  capabilities: NodeCapabilities;
  /** JSON Schema of the node's `with` block. */
  configSchema?: Record<string, unknown>;
}

/** Every registered node type (built-in and plugin) as UI descriptors. */
export function describeNodeTypes(): NodeTypeDescriptor[] {
  return registry.types().map((type) => {
    const f = registry.get(type)!;
    let configSchema: Record<string, unknown> | undefined;
    try {
      configSchema = zodToConfigJsonSchema(f.configSchema);
    } catch {
      configSchema = undefined; // a schema that cannot be described still lists
    }
    return {
      type,
      label: f.ui?.label ?? type,
      ...(f.ui?.description ? { description: f.ui.description } : {}),
      category: f.ui?.category ?? "custom",
      ...(f.ui?.icon ? { icon: f.ui.icon } : {}),
      ...(f.ui?.color ? { color: f.ui.color } : {}),
      capabilities: f.capabilities,
      ...(configSchema ? { configSchema } : {}),
    };
  });
}
