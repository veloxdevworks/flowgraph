/**
 * Node Registry — maps type strings to NodeFactory implementations.
 * Third-party node plugins register factories here.
 */

import { z } from "zod";
import { zodToConfigJsonSchema } from "@flowgraph/spec";
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

class Registry {
  private factories = new Map<string, NodeFactory>();
  private reducers = new Map<string, ReducerFn>();

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
