/**
 * Node Registry — maps type strings to NodeFactory implementations.
 * Third-party node plugins register factories here.
 */

import { z } from "zod";
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
  resolveSkill?: (uses: string) => Promise<unknown>;
  resolveSubgraph?: (uses: string) => Promise<unknown>;
  /** Wiring for node-as-tool execution, populated by the compiler. */
  toolWiring?: {
    invokeNode?: (
      id: string,
      args: Record<string, unknown>,
      ctx: NodeRunContext,
    ) => Promise<unknown>;
    /** Look up description/schema for a sibling node exposed as a tool. */
    resolveToolMeta?: (nodeId: string) => {
      description?: string;
      schema?: Record<string, unknown>;
    } | undefined;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface NodeFactory<Config = any> {
  type: string;
  configSchema: z.ZodType<Config>;
  capabilities: NodeCapabilities;
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
