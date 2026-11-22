/**
 * Preview: generative media nodes (`image`, `video`, `model3d`, `audio`),
 * `kind: media` provider configuration, media job runtime, and vendor adapters.
 */

import { registerProviderKindSchema, type Diagnostic, type GraphSpec } from "@flowgraph/spec";
import { registry, walkNodes } from "@flowgraph/core";
import {
  deriveMediaProviders,
  getMediaVendor,
  GRAPH_MEDIA_PROVIDERS,
  listMediaVendors,
  mediaProviderFor,
  mediaProviderList,
  mediaProvidersFor,
  registerMediaProvider,
  registerMediaVendor,
  unregisterMediaVendor,
  type GraphMediaProviders,
} from "./runtime/registry.js";
import type { MediaModality, MediaProvider, MediaVendor } from "./runtime/types.js";
import { audioNode, imageNode, model3dNode, videoNode } from "./nodes.js";
import { MediaProviderConfigSchema } from "./schema.js";
import { elevenlabsVendor } from "./vendors/elevenlabs.js";
import { meshyVendor } from "./vendors/meshy.js";
import { openaiVendor } from "./vendors/openai.js";
import { tripoVendor } from "./vendors/tripo.js";
import { xaiVendor } from "./vendors/xai.js";

export const MEDIA_VENDORS: readonly MediaVendor[] = [
  xaiVendor,
  openaiVendor,
  tripoVendor,
  meshyVendor,
  elevenlabsVendor,
];

const MEDIA_NODES = [imageNode, videoNode, model3dNode, audioNode] as const;

function validateMediaRequests(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  walkNodes(spec, (node) => {
    if (!["image", "video", "audio", "model3d"].includes(String(node.type))) return;
    const name = node.provider ?? spec.config?.defaults?.provider;
    const cfg = typeof name === "string"
      ? (spec.providers?.[name] as Record<string, unknown> | undefined)
      : undefined;
    const vendorName = cfg && typeof cfg.vendor === "string" ? cfg.vendor : String(name ?? "");
    const vendor = getMediaVendor(vendorName);
    if (!vendor) return;
    const w = (node.with as Record<string, unknown>) ?? {};
    if (JSON.stringify([w.model, w.size, w.params]).includes("{{")) return;
    try {
      vendor
        .create({
          name: String(name),
          ...(cfg?.kind === "media"
            ? {
                model: typeof cfg.model === "string" ? cfg.model : undefined,
                options: cfg.options as Record<string, unknown> | undefined,
              }
            : {}),
        })
        .validateRequest?.({
          modality: node.type as MediaModality,
          model: typeof node.model === "string" ? node.model : typeof w.model === "string" ? w.model : undefined,
          inputs: [],
          count: 1,
          params: (w.params as Record<string, unknown>) ?? {},
          ...(typeof w.size === "string" ? { size: w.size } : {}),
        });
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "MEDIA_REQUEST_INVALID",
        path: `nodes.${node.id}.with`,
        message: `Media node "${node.id}": ${String(err)}`,
      });
    }
  });
  return diagnostics;
}

/** Register the four media node types, `kind: media` schema, and compile/validation hooks (idempotent). */
export function registerMediaNodes(): void {
  registerProviderKindSchema("media", MediaProviderConfigSchema);
  for (const node of MEDIA_NODES) {
    if (!registry.has(node.type)) registry.register(node);
  }
  registry.registerValidator("media-requests", validateMediaRequests);
  registry.registerSubgraphContextSymbol(GRAPH_MEDIA_PROVIDERS);
  registry.registerProviderSecretResolver("media", (cfg) => {
    const vendor = typeof cfg.vendor === "string" ? cfg.vendor : undefined;
    return vendor ? getMediaVendor(vendor)?.defaultApiKeyEnv : undefined;
  });
  registry.registerCompileContext("media-providers", ({ spec, opts, contextBag }) => {
    const inherited = (contextBag[GRAPH_MEDIA_PROVIDERS] as GraphMediaProviders | undefined)?.byName;
    const explicit = Array.isArray(opts.mediaProviders) ? (opts.mediaProviders as MediaProvider[]) : [];
    const derived = deriveMediaProviders(spec.providers as Record<string, Record<string, unknown>> | undefined);
    const merged = [
      ...(inherited ? [...inherited.values()] : []),
      ...explicit,
      ...derived,
    ];
    if (merged.length) {
      const graphMedia: GraphMediaProviders = { byName: new Map(merged.map((p) => [p.name, p])) };
      contextBag[GRAPH_MEDIA_PROVIDERS] = graphMedia;
    }
  });
}

/** Register every built-in vendor above (idempotent). Runs on import. */
export function registerMediaVendors(): void {
  for (const v of MEDIA_VENDORS) registerMediaVendor(v);
}

registerMediaNodes();
registerMediaVendors();

export { xaiVendor, openaiVendor, tripoVendor, meshyVendor, elevenlabsVendor };
export { VendorHttpError, resolveApiKey, requestJson, joinUrl, base64ToBytes } from "./http.js";

export { imageNode, videoNode, model3dNode, audioNode };
export {
  ImageWithSchema,
  VideoWithSchema,
  Model3dWithSchema,
  Model3dFormatSchema,
  AudioWithSchema,
  AudioKindSchema,
  MediaProviderConfigSchema,
  type ImageWith,
  type VideoWith,
  type Model3dWith,
  type AudioWith,
  type MediaProviderConfig,
} from "./schema.js";

export {
  registerMediaVendor,
  unregisterMediaVendor,
  registerMediaProvider,
  getMediaVendor,
  listMediaVendors,
  deriveMediaProviders,
  mediaProviderFor,
  mediaProvidersFor,
  mediaProviderList,
  GRAPH_MEDIA_PROVIDERS,
  type GraphMediaProviders,
};
export { runMediaJob, type RunMediaJobOptions, type MediaJobResult } from "./runtime/run-job.js";
export {
  createFileJournal,
  listMediaJournals,
  fingerprintRequest,
  resolveMediaSubmission,
  type Journal,
  type JournalEntry,
} from "./runtime/journal.js";
export { resolveMediaInputs } from "./runtime/inputs.js";
export {
  MediaSubmissionRejectedError,
  type MediaModality,
  type MediaInput,
  type MediaRequest,
  type MediaOutput,
  type MediaCallContext,
  type MediaProvider,
  type MediaVendor,
  type MediaVendorOptions,
  type JobHandle,
  type JobStatus,
  type JobState,
} from "./runtime/types.js";
