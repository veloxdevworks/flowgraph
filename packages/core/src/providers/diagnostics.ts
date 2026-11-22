import type { Diagnostic, GraphSpec, NodeSpec } from "@flowgraph/spec";
import type { ProviderAdapter, ProviderPlugin } from "./types.js";
import { getProvider, getProviderPlugin, validatePluginProviderOptions } from "./registry.js";
import { langchainConfigDiagnostics } from "./langchain/provider.js";
import { providerSecretDiagnostics } from "../runtime/secret-declarations.js";
import { effectiveModel } from "./model-choice.js";

/** The parts of a provider adapter that config diagnostics read. */
export type ProviderValidation = Pick<ProviderAdapter, "name" | "validate"> & {
  capabilities: Pick<ProviderAdapter["capabilities"], "models">;
};

function providerNameOf(spec: GraphSpec, node: NodeSpec): string | undefined {
  if (typeof node.provider === "string") return node.provider;
  const fallback = spec.config?.defaults?.provider;
  return typeof fallback === "string" ? fallback : undefined;
}

function isModelNode(node: NodeSpec): boolean {
  const type = String(node.type);
  if (type === "agent") return true;
  if (type === "router" && (node.with as { mode?: unknown } | undefined)?.mode === "model")
    return true;
  return false;
}

/**
 * Validation-only adapters for offline checks (`flowgraph validate`), built
 * without loading vendor packages, reading credentials or calling the network.
 * LangChain entries in the graph's `providers:` block check builtin tools and
 * the configured model, as the adapter built from them at compile would.
 * Providers registered in this process answer with their own `validate()`.
 */
export function offlineProviderValidations(spec: GraphSpec): ProviderValidation[] {
  const out = new Map<string, ProviderValidation>();
  for (const [name, cfg] of Object.entries(spec.providers ?? {})) {
    if (cfg?.kind !== "langchain") continue;
    out.set(name, {
      name,
      // The configured model is a default, not a list of known models (see factory.ts).
      capabilities: {},
      validate: langchainConfigDiagnostics,
    });
  }
  for (const node of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (!node || typeof node !== "object") continue;
    const name = providerNameOf(spec, node);
    if (!name || out.has(name) || spec.providers?.[name]) continue;
    const registered = getProvider(name);
    if (registered) out.set(name, registered);
  }
  return [...out.values()];
}

/**
 * Compile- and validate-time checks for provider options the runtime would
 * otherwise ignore. Each adapter's `validate()` runs and known model ids are
 * checked. Compile passes the graph's adapters; offline validation passes
 * `offlineProviderValidations(spec)`. A node on the built-in `langchain`
 * provider with no adapter still gets the LangChain builtin-tool warnings.
 */
export function providerConfigDiagnostics(
  spec: GraphSpec,
  providers: readonly ProviderValidation[] = [],
  opts: { pluginRegistry?: ReadonlyMap<string, ProviderPlugin>; checkPluginOptions?: boolean } = {},
): Diagnostic[] {
  const byName = new Map(providers.map((p) => [p.name, p]));
  const out: Diagnostic[] = [];

  if (opts.checkPluginOptions !== false) {
    for (const [name, cfg] of Object.entries(spec.providers ?? {})) {
      if (cfg?.kind !== "plugin") continue;
      const pluginName = cfg.plugin ?? name;
      const plugin = opts.pluginRegistry?.get(pluginName) ?? getProviderPlugin(pluginName);
      if (!plugin) continue;
      const checked = validatePluginProviderOptions(plugin, cfg.options, {
        name,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
        ...(cfg.apiKeyEnv !== undefined ? { apiKeyEnv: cfg.apiKeyEnv } : {}),
      });
      for (const err of checked.errors) {
        out.push({
          severity: "error",
          code: "PROVIDER_OPTIONS_INVALID",
          message: `Provider "${name}" (plugin "${pluginName}"): ${err}`,
          path: `providers.${name}.options`,
        });
      }
      for (const warn of checked.warnings) {
        out.push({
          severity: "warning",
          code: "PROVIDER_CONFIG_UNSUPPORTED",
          message: `Provider "${name}" (plugin "${pluginName}"): ${warn}`,
          path: `providers.${name}.options`,
        });
      }
    }
  }

  for (const node of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (!node || typeof node !== "object" || !isModelNode(node)) continue;
    const name = providerNameOf(spec, node);
    const adapter = name ? byName.get(name) : undefined;
    const declared = name ? spec.providers?.[name] : undefined;
    const langchain =
      declared?.kind === "langchain" ||
      adapter?.name === "langchain" ||
      name === "langchain";

    if (adapter?.validate) {
      const providerModel = declared && "model" in declared && typeof declared.model === "string" ? declared.model : undefined;
      const requested = effectiveModel(
        name && name === spec.config?.defaults?.provider
          ? { model: typeof node.model === "string" ? node.model : spec.config?.defaults?.model, modelSource: typeof node.model === "string" ? "node" : "default" }
          : { model: typeof node.model === "string" ? node.model : undefined, modelSource: "node" },
        providerModel,
      );
      const validateNode = { id: node.id, ...(typeof requested === "string" ? { model: requested } : {}) };
      for (const diag of adapter.validate(node.with ?? {}, validateNode)) {
        out.push({
          severity: diag.severity,
          code: diag.severity === "error" ? "PROVIDER_CONFIG_ERROR" : "PROVIDER_CONFIG_UNSUPPORTED",
          message: diag.message,
          path: `nodes.${node.id}.with`,
        });
      }
    } else if (langchain) {
      for (const diag of langchainConfigDiagnostics(node.with ?? {})) {
        out.push({
          severity: diag.severity,
          code: diag.severity === "error" ? "PROVIDER_CONFIG_ERROR" : "PROVIDER_CONFIG_UNSUPPORTED",
          message: diag.message,
          path: `nodes.${node.id}.with.tools`,
        });
      }
    }

    const models = adapter?.capabilities?.models;
    const model = typeof node.model === "string" ? node.model : undefined;
    if (model && models && models.length > 0 && !models.includes(model)) {
      out.push({
        severity: "warning",
        code: "PROVIDER_MODEL_UNKNOWN",
        message: `Model "${model}" is not in the known models for provider "${name ?? "unknown"}" (${models.join(", ")}). The override is still forwarded; the provider may reject it.`,
        path: `nodes.${node.id}.model`,
      });
    }
  }
  out.push(...providerSecretDiagnostics(spec));
  return out;
}
