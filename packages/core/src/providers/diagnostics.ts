import type { Diagnostic, GraphSpec, NodeSpec } from "@flowgraph/spec";
import type { ProviderAdapter } from "./types.js";

function providerNameOf(spec: GraphSpec, node: NodeSpec): string | undefined {
  const withBlock = (node.with ?? {}) as { provider?: unknown };
  if (typeof node.provider === "string") return node.provider;
  if (typeof withBlock.provider === "string") return withBlock.provider;
  const fallback = spec.config?.defaults?.provider;
  return typeof fallback === "string" ? fallback : undefined;
}

function isModelNode(node: NodeSpec): boolean {
  const type = String(node.type);
  if (type === "agent" || type === "intelligent") return true;
  if (type === "router" && (node.with as { mode?: unknown } | undefined)?.mode === "model")
    return true;
  return false;
}

/**
 * Compile- and validate-time checks for provider options the runtime would
 * otherwise ignore. When `providers` is passed (compile), each adapter's
 * `validate()` runs and known model ids are checked. Without adapters
 * (offline `flowgraph validate`), LangChain builtin-tool warnings still apply
 * from the graph's `providers:` block.
 */
export function providerConfigDiagnostics(
  spec: GraphSpec,
  providers: readonly ProviderAdapter[] = [],
): Diagnostic[] {
  const byName = new Map(providers.map((p) => [p.name, p]));
  const out: Diagnostic[] = [];

  for (const node of spec.nodes) {
    if (!isModelNode(node)) continue;
    const name = providerNameOf(spec, node);
    const adapter = name ? byName.get(name) : undefined;
    const declared = name ? spec.providers?.[name] : undefined;
    const langchain =
      declared?.kind === "langchain" ||
      adapter?.name === "langchain" ||
      name === "langchain" ||
      (!declared && !adapter && name === "langchain");

    if (adapter?.validate) {
      for (const diag of adapter.validate(node.with ?? {})) {
        out.push({
          severity: diag.severity,
          code: diag.severity === "error" ? "PROVIDER_CONFIG_ERROR" : "PROVIDER_CONFIG_UNSUPPORTED",
          message: diag.message,
          path: `nodes.${node.id}.with`,
        });
      }
    } else if (langchain) {
      const tools =
        (node.with as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? [];
      for (const t of tools) {
        if ("builtin" in t) {
          out.push({
            severity: "warning",
            code: "PROVIDER_CONFIG_UNSUPPORTED",
            message: `LangChain provider has no provider-native builtin tools; "${JSON.stringify(t.builtin)}" will not work.`,
            path: `nodes.${node.id}.with.tools`,
          });
        }
      }
    }

    const models = adapter?.capabilities.models;
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
  return out;
}
