/**
 * Provider registry and tool-function registry for intelligent nodes.
 */

import type { ProviderAdapter } from "./types.js";
import type { NodeRunContext } from "../context.js";

const providers = new Map<string, ProviderAdapter>();

export function registerProvider(adapter: ProviderAdapter): void {
  providers.set(adapter.name, adapter);
}

export function getProvider(name: string): ProviderAdapter | undefined {
  return providers.get(name);
}

export function hasProvider(name: string): boolean {
  return providers.has(name);
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

/**
 * Providers a compiled graph was given, on its run context under this key.
 * They answer before the process-wide registry, so a provider of the same
 * name registered by another graph cannot replace them. When `exclusive`
 * (graphs compiled under a node policy), the process-wide registry is not
 * consulted at all.
 */
export const GRAPH_PROVIDERS: unique symbol = Symbol.for("flowgraph.graphProviders");

export interface GraphProviders {
  byName: ReadonlyMap<string, ProviderAdapter>;
  exclusive: boolean;
}

function graphProvidersOf(ctx: object): GraphProviders | undefined {
  return (ctx as Record<symbol, unknown>)[GRAPH_PROVIDERS] as GraphProviders | undefined;
}

/** The provider a node in this run should use for `name`. */
export function providerFor(ctx: object, name: string): ProviderAdapter | undefined {
  const scoped = graphProvidersOf(ctx);
  const own = scoped?.byName.get(name);
  if (own) return own;
  return scoped?.exclusive ? undefined : providers.get(name);
}

/** Provider names a node in this run can use. */
export function providerNamesFor(ctx: object): string[] {
  const scoped = graphProvidersOf(ctx);
  const own = [...(scoped?.byName.keys() ?? [])];
  if (scoped?.exclusive) return own;
  return [...new Set([...own, ...providers.keys()])];
}

/** The providers this run's graph was given (handed on to inline and file subgraphs). */
export function graphProviderList(ctx: object): ProviderAdapter[] {
  return [...(graphProvidersOf(ctx)?.byName.values() ?? [])];
}

// ---------------------------------------------------------------------------
// Function tools — register a plain function to be exposed to agents as a tool.
// ---------------------------------------------------------------------------

export interface ToolFunctionDef {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  handler: (args: unknown, ctx: NodeRunContext) => Promise<unknown> | unknown;
}

const toolFunctions = new Map<string, ToolFunctionDef>();

export function registerTool(def: ToolFunctionDef): void {
  toolFunctions.set(def.name, def);
}

export function getTool(name: string): ToolFunctionDef | undefined {
  return toolFunctions.get(name);
}
