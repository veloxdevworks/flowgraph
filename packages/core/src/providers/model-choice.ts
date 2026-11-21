/**
 * Model choice for one provider call.
 *
 * Node model, then the provider's own model, then `config.defaults.model`
 * only when the call uses the default provider.
 */

export type ModelSource = "node" | "default";

export function modelRequest(
  nodeModel: string | undefined,
  providerName: string | undefined,
  defaults: { provider?: string | undefined; model?: string | undefined } | undefined,
): { model?: string; modelSource?: ModelSource } {
  if (nodeModel) return { model: nodeModel, modelSource: "node" };
  if (
    providerName &&
    defaults?.provider &&
    providerName === defaults.provider &&
    defaults.model
  ) {
    return { model: defaults.model, modelSource: "default" };
  }
  return {};
}

/** Provider model wins over a graph default. A node model wins over both. */
export function effectiveModel(
  req: { model?: string | undefined; modelSource?: ModelSource | undefined },
  providerModel?: string,
): string | undefined {
  if (req.model && req.modelSource !== "default") return req.model;
  return providerModel ?? req.model;
}
