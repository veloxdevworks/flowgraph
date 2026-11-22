/**
 * Node Registry — maps type strings to NodeFactory implementations.
 * Each graph compilation forks from the base registry so imported plugins stay
 * scoped to that compile rather than leaking into process-wide state.
 */

import { z } from "zod";
import { isNamespacedPluginType, zodToConfigJsonSchema } from "@flowgraph/spec";
import type { ContextConfigInput } from "./context/types.js";
import type { NodeRunContext } from "./context.js";

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
  /** Per-compile node & reducer registry (defaults to the global base registry). */
  registry?: NodeRegistry;
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

export interface RegisterNodeOptions {
  /** When true, require a namespaced plugin type (e.g. `acme:greet` or `@acme/pkg:greet`). */
  plugin?: boolean;
  /** Optional import specifier or origin describing where this node type was registered from. */
  source?: string;
}

function registryError(code: string, message: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(message), { code, retryable: false as const });
}

export class NodeRegistry {
  private readonly parent?: NodeRegistry | undefined;
  private factories = new Map<string, NodeFactory>();
  private factorySources = new Map<string, string>();
  private reducers = new Map<string, ReducerFn>();

  constructor(parent?: NodeRegistry) {
    this.parent = parent;
  }

  /** Create an isolated child registry that reads from this registry without mutating it. */
  fork(): NodeRegistry {
    return new NodeRegistry(this);
  }

  private getFactorySource(type: string): string | undefined {
    return this.factorySources.get(type) ?? this.parent?.getFactorySource(type);
  }

  register(factory: NodeFactory, opts: RegisterNodeOptions = {}): void {
    const existing = this.get(factory.type);
    if (existing !== undefined) {
      if (existing === factory) return;
      const existingSource = this.getFactorySource(factory.type);
      const target = existingSource
        ? `node type imported from "${existingSource}"`
        : this.parent?.has(factory.type)
          ? "built-in or host node type"
          : "node type";
      throw registryError(
        "PLUGIN_TYPE_COLLISION",
        `Node type "${factory.type}" collides with an already-registered ${target}.`,
      );
    }
    if (opts.plugin && !isNamespacedPluginType(factory.type)) {
      throw registryError(
        "PLUGIN_TYPE_INVALID",
        `Plugin node type "${factory.type}" must be namespaced (for example "acme:my-node" or "@acme/pkg:my-node").`,
      );
    }
    this.factories.set(factory.type, factory);
    if (opts.source) this.factorySources.set(factory.type, opts.source);
  }

  get(type: string): NodeFactory | undefined {
    return this.factories.get(type) ?? this.parent?.get(type);
  }

  has(type: string): boolean {
    return this.factories.has(type) || (this.parent?.has(type) ?? false);
  }

  types(): string[] {
    if (!this.parent) return [...this.factories.keys()];
    return [...new Set([...this.parent.types(), ...this.factories.keys()])];
  }

  registerReducer(name: string, fn: ReducerFn): void {
    const existing = this.getReducer(name);
    if (existing !== undefined) {
      if (existing === fn) return;
      throw registryError(
        "PLUGIN_REDUCER_COLLISION",
        `Reducer "${name}" is already registered.`,
      );
    }
    this.reducers.set(name, fn);
  }

  getReducer(name: string): ReducerFn | undefined {
    return this.reducers.get(name) ?? this.parent?.getReducer(name);
  }

  hasReducer(name: string): boolean {
    return this.reducers.has(name) || (this.parent?.hasReducer(name) ?? false);
  }
}

export const registry = new NodeRegistry();

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
export function describeNodeTypes(reg: NodeRegistry = registry): NodeTypeDescriptor[] {
  return reg.types().map((type) => {
    const f = reg.get(type)!;
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
