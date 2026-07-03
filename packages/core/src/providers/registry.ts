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
