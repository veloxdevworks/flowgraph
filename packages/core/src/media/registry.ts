/**
 * Media vendor + provider registry.
 *
 * Vendors (`xai`, `openai`, `tripo`, ...) register a factory. Providers are
 * built from a graph's `providers:` block, so credentials are configured once:
 *
 *   providers:
 *     grok: { kind: langchain, vendor: xai }     # LLM + image + video
 *     tripo: { kind: media, vendor: tripo }      # dedicated media backend
 *
 * A `langchain` entry whose vendor has a registered media factory also becomes
 * a media provider under the same name, with the same `apiKeyEnv` / `baseUrl`.
 */

import type { ProviderConfig } from "@flowgraph/spec";
import type { MediaModality, MediaProvider, MediaVendor } from "./types.js";

const vendors = new Map<string, MediaVendor>();
const providers = new Map<string, MediaProvider>();
const bareProviders = new Map<string, MediaProvider>();

/** Graph-scoped media providers on the run context (same pattern as GRAPH_PROVIDERS). */
export const GRAPH_MEDIA_PROVIDERS: unique symbol = Symbol.for("flowgraph.graphMediaProviders");

export interface GraphMediaProviders {
  byName: ReadonlyMap<string, MediaProvider>;
}

export function registerMediaVendor(vendor: MediaVendor): void {
  vendors.set(vendor.vendor, vendor);
  bareProviders.delete(vendor.vendor);
}

export function getMediaVendor(vendor: string): MediaVendor | undefined {
  return vendors.get(vendor);
}

export function listMediaVendors(): string[] {
  return [...vendors.keys()];
}

/** Register a ready-made provider process-wide (plugins that bring their own). */
export function registerMediaProvider(provider: MediaProvider): void {
  providers.set(provider.name, provider);
}

/**
 * Media providers implied by a graph's `providers:` block. A `kind: media`
 * entry must name a registered vendor; LLM entries are included only when a
 * media factory exists for their vendor.
 */
export function deriveMediaProviders(configs: Record<string, ProviderConfig> | undefined): MediaProvider[] {
  const out: MediaProvider[] = [];
  for (const [name, cfg] of Object.entries(configs ?? {})) {
    if (cfg.kind === "media") {
      const vendor = vendors.get(cfg.vendor);
      if (!vendor) {
        const known = listMediaVendors();
        throw new Error(
          `Provider "${name}": unknown media vendor "${cfg.vendor}". ` +
            (known.length
              ? `Registered: ${known.join(", ")}.`
              : `No media vendors are registered; install @flowgraph/media or add an imports.providers plugin.`),
        );
      }
      out.push(
        vendor.create({
          name,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          apiKeyEnv: cfg.apiKeyEnv ?? vendor.defaultApiKeyEnv,
          options: cfg.options,
        }),
      );
    } else if (cfg.kind === "langchain") {
      const vendor = vendors.get(cfg.vendor);
      if (!vendor) continue;
      // The entry's `model` is an LLM model id; it is not a media model.
      out.push(
        vendor.create({
          name,
          baseUrl: cfg.baseUrl,
          apiKeyEnv: cfg.apiKeyEnv ?? vendor.defaultApiKeyEnv,
        }),
      );
    }
  }
  return out;
}

function graphMediaOf(ctx: object): GraphMediaProviders | undefined {
  return (ctx as Record<symbol, unknown>)[GRAPH_MEDIA_PROVIDERS] as GraphMediaProviders | undefined;
}

/** A media provider by name: this graph's, then process-wide, then a bare vendor name (`xai`). */
export function mediaProviderFor(ctx: object, name: string): MediaProvider | undefined {
  const own = graphMediaOf(ctx)?.byName.get(name);
  if (own) return own;
  const global = providers.get(name);
  if (global) return global;
  const vendor = vendors.get(name);
  if (!vendor) return undefined;
  let bare = bareProviders.get(name);
  if (!bare) {
    bare = vendor.create({ name, apiKeyEnv: vendor.defaultApiKeyEnv });
    bareProviders.set(name, bare);
  }
  return bare;
}

/** Every media provider a node in this run can use for `modality`. */
export function mediaProvidersFor(ctx: object, modality: MediaModality): MediaProvider[] {
  const all = new Map<string, MediaProvider>();
  for (const p of providers.values()) all.set(p.name, p);
  for (const p of graphMediaOf(ctx)?.byName.values() ?? []) all.set(p.name, p);
  return [...all.values()].filter((p) => p.modalities.includes(modality));
}

export function mediaProviderList(ctx: object): MediaProvider[] {
  return [...(graphMediaOf(ctx)?.byName.values() ?? [])];
}
