/**
 * Provider registry, provider plugin registry, and tool-function registry for agent nodes.
 */

import type { PluginProviderConfig } from "@flowgraph/spec";
import type { ProviderAdapter, ProviderPlugin, ProviderPluginContext } from "./types.js";
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
// Provider plugins (`providers.<name>: { kind: plugin, options: ... }`)
// ---------------------------------------------------------------------------

const providerPlugins = new Map<string, ProviderPlugin>();

export function registerProviderPlugin(plugin: ProviderPlugin): void {
  providerPlugins.set(plugin.name, plugin);
}

export function unregisterProviderPlugin(name: string): void {
  providerPlugins.delete(name);
}

export function getProviderPlugin(name: string): ProviderPlugin | undefined {
  return providerPlugins.get(name);
}

export function listProviderPlugins(): string[] {
  return [...providerPlugins.keys()];
}

export interface PluginOptionsValidationResult<Options = unknown> {
  ok: boolean;
  options: Options;
  errors: string[];
  warnings: string[];
}

export function validatePluginProviderOptions<Options = unknown>(
  plugin: ProviderPlugin<Options>,
  rawOptions: Record<string, unknown> | undefined,
  ctx: ProviderPluginContext,
): PluginOptionsValidationResult<Options> {
  const input = rawOptions ?? {};
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown = input;

  if (plugin.optionsSchema) {
    const res = plugin.optionsSchema.safeParse(input);
    if (!res.success) {
      for (const issue of res.error.issues) {
        const at = issue.path.join(".");
        errors.push(at ? `${at}: ${issue.message}` : issue.message);
      }
      return { ok: false, options: input as Options, errors, warnings };
    }
    parsed = res.data;
  }

  if (plugin.validateOptions) {
    for (const diag of plugin.validateOptions(parsed as Options, ctx)) {
      if (diag.severity === "error") errors.push(diag.message);
      else warnings.push(diag.message);
    }
  }

  return { ok: errors.length === 0, options: parsed as Options, errors, warnings };
}

export async function createPluginProvider(
  name: string,
  cfg: PluginProviderConfig,
  opts: {
    plugins?: ReadonlyMap<string, ProviderPlugin>;
    env?: Record<string, string | undefined>;
    allowGlobal?: boolean;
  } = {},
): Promise<{ adapter: ProviderAdapter; warnings: string[] }> {
  const pluginName = cfg.plugin ?? name;
  const plugin =
    opts.plugins?.get(pluginName) ??
    (opts.allowGlobal === false ? undefined : providerPlugins.get(pluginName));
  if (!plugin) {
    throw Object.assign(
      new Error(
        `Provider "${name}" references plugin "${pluginName}", which is not registered. ` +
          `Import it via imports[].providers or call registerProviderPlugin().`,
      ),
      { code: "PROVIDER_PLUGIN_NOT_FOUND", retryable: false },
    );
  }
  const env = opts.env ?? process.env;
  const apiKey = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined;
  const ctx: ProviderPluginContext = {
    name,
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.apiKeyEnv !== undefined ? { apiKeyEnv: cfg.apiKeyEnv } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
  const checked = validatePluginProviderOptions(plugin, cfg.options, ctx);
  if (!checked.ok) {
    throw Object.assign(
      new Error(
        `Provider "${name}" (plugin "${pluginName}") has invalid options: ${checked.errors.join("; ")}`,
      ),
      { code: "PROVIDER_OPTIONS_INVALID", retryable: false },
    );
  }
  const built = await plugin.create(checked.options, ctx);
  const adapter: ProviderAdapter = {
    ...built,
    name,
    capabilities: built.capabilities ?? { streaming: false, toolCalling: false, structuredOutput: false },
  };
  return { adapter, warnings: checked.warnings };
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
