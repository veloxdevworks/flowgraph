/**
 * Built-in node types: `image`, `video`, `model3d`
 *
 * Generative media nodes. They share one implementation: resolve a
 * `MediaProvider`, run (or re-attach to) one or more jobs through the
 * write-ahead journal, save the results as Artifacts, charge the run budget.
 * Vendors live behind `MediaProvider` (see media/types.ts, ADR-0017).
 */

import { z } from "zod";
import { AudioWithSchema, ImageWithSchema, Model3dWithSchema, VideoWithSchema, type Artifact } from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult, type NodeUiMeta } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { applyOutput } from "./output.js";
import { enforceBudget } from "./agent.js";
import { createOutputWriter } from "../media/artifacts.js";
import { resolveMediaInputs } from "../media/inputs.js";
import { createFileJournal, fingerprintRequest } from "../media/journal.js";
import { mediaProviderFor, mediaProvidersFor } from "../media/registry.js";
import { runMediaJob } from "../media/run-job.js";
import type { MediaCallContext, MediaModality, MediaProvider, MediaRequest } from "../media/types.js";

interface ModalitySpec {
  type: MediaModality;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodType<any>;
  defaultTimeout: string;
  ui: NodeUiMeta;
}

const MODALITIES: Record<MediaModality, ModalitySpec> = {
  image: {
    type: "image",
    schema: ImageWithSchema,
    defaultTimeout: "5m",
    ui: { label: "Image", description: "Generate or edit an image", category: "media", icon: "image", color: "#ec4899" },
  },
  video: {
    type: "video",
    schema: VideoWithSchema,
    defaultTimeout: "15m",
    ui: { label: "Video", description: "Generate a video clip", category: "media", icon: "video", color: "#f97316" },
  },
  model3d: {
    type: "model3d",
    schema: Model3dWithSchema,
    defaultTimeout: "15m",
    ui: { label: "3D model", description: "Generate a 3D asset", category: "media", icon: "box", color: "#8b5cf6" },
  },
  audio: {
    type: "audio",
    schema: AudioWithSchema,
    defaultTimeout: "10m",
    ui: { label: "Audio", description: "Generate speech, sound effects or music", category: "media", icon: "audio-lines", color: "#14b8a6" },
  },
};

type Config = Record<string, unknown> & {
  prompt?: string;
  negativePrompt?: string;
  input?: unknown;
  count?: number;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  seed?: number;
  duration?: number;
  resolution?: string;
  mode?: "text" | "image" | "multiview";
  kind?: "speech" | "sfx" | "music";
  text?: string;
  voice?: string;
  language?: string;
  instrumental?: boolean;
  format?: string;
  texture?: boolean;
  params?: Record<string, unknown>;
  timeout?: string;
  output?: Parameters<typeof applyOutput>[0];
};

type AudioKind = "speech" | "sfx" | "music";

/** Can this provider make this modality (and, for audio, this kind)? */
function supports(p: MediaProvider, modality: MediaModality, kind: AudioKind | undefined): boolean {
  if (!p.modalities.includes(modality)) return false;
  if (modality === "audio" && kind && p.audioKinds) return p.audioKinds.includes(kind);
  return true;
}

function resolveProvider(
  ctx: NodeRunContext,
  modality: MediaModality,
  nodeId: string,
  named: string | undefined,
  kind: AudioKind | undefined,
): MediaProvider {
  const what = modality === "audio" && kind ? `audio (${kind})` : modality;
  const wanted = named ?? undefined;
  if (wanted) {
    const p = mediaProviderFor(ctx, wanted);
    if (!p) {
      const avail = mediaProvidersFor(ctx, modality).filter((x) => supports(x, modality, kind)).map((x) => x.name);
      throw new Error(
        `${modality} node "${nodeId}": no media provider named "${wanted}". ` +
          (avail.length ? `Available for ${modality}: ${avail.join(", ")}.` : `None are configured for ${modality}.`) +
          ` Declare it under providers: (a langchain xai/openai entry works, or kind: media).`,
      );
    }
    if (!supports(p, modality, kind)) {
      throw new Error(`${modality} node "${nodeId}": provider "${wanted}" (${p.vendor}) does not support ${what}.`);
    }
    return p;
  }
  // No provider on the node: prefer the graph default when it can do this, else the only candidate.
  const def = ctx.config.defaults?.provider;
  if (def) {
    const p = mediaProviderFor(ctx, def);
    if (p && supports(p, modality, kind)) return p;
  }
  const candidates = mediaProvidersFor(ctx, modality).filter((x) => supports(x, modality, kind));
  if (candidates.length === 1) return candidates[0]!;
  throw new Error(
    `${modality} node "${nodeId}": set provider:. ` +
      (candidates.length
        ? `Candidates: ${candidates.map((c) => c.name).join(", ")}.`
        : `No media provider supports ${what}; declare one under providers: (e.g. a langchain xai/openai entry or kind: media).`),
  );
}

function splitCounts(total: number, perJob: number): number[] {
  const jobs: number[] = [];
  for (let left = total; left > 0; left -= perJob) jobs.push(Math.min(perJob, left));
  return jobs;
}

function buildMediaNode(spec: ModalitySpec) {
  const modality = spec.type;
  return defineNode<Config>({
    type: spec.type,
    configSchema: spec.schema,
    capabilities: { sideEffecting: true },
    ui: spec.ui,

    build(_buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
      const nodeId = String(nodeSpec["id"]);

      return {
        contract: {},
        capabilities: { sideEffecting: true },

        async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
          const scope = {
            state,
            input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
            config: ctx.config,
            run: ctx.meta,
          };
          const str = (v: unknown): string | undefined => {
            if (typeof v !== "string") return undefined;
            const r = renderDeep(v, scope);
            return r == null ? undefined : String(r);
          };

          const provider = resolveProvider(
            ctx,
            modality,
            nodeId,
            typeof nodeSpec["provider"] === "string" ? nodeSpec["provider"] : undefined,
            modality === "audio" ? config.kind : undefined,
          );
          const model = typeof nodeSpec["model"] === "string" ? nodeSpec["model"] : undefined;

          const callFetch: typeof fetch = (...args) => globalThis.fetch(...args);
          const rawInput = renderDeep(config.input as never, scope);
          const inputs = await resolveMediaInputs(rawInput, ctx, { fetchImpl: callFetch, signal: ctx.signal });

          const mode =
            modality === "model3d"
              ? (config.mode ?? (inputs.length === 0 ? "text" : inputs.length === 1 ? "image" : "multiview"))
              : undefined;

          const base: Omit<MediaRequest, "count"> = {
            modality,
            model,
            prompt: str(config.prompt),
            negativePrompt: str(config.negativePrompt),
            inputs,
            size: str(config.size),
            aspectRatio: str(config.aspectRatio),
            quality: str(config.quality),
            seed: config.seed,
            duration: config.duration,
            resolution: str(config.resolution),
            mode,
            format: modality === "model3d" || modality === "audio" ? str(config.format) : undefined,
            audioKind: modality === "audio" ? config.kind : undefined,
            text: str(config.text),
            voice: str(config.voice),
            language: str(config.language),
            instrumental: config.instrumental,
            texture: config.texture,
            params: (renderDeep((config.params ?? {}) as never, scope) as Record<string, unknown>) ?? {},
          };

          const total = config.count ?? 1;
          const perJob = Math.max(1, provider.maxPerJob?.[modality] ?? 1);
          const counts = splitCounts(total, perJob);
          const jobScope = ctx.meta.threadId ?? ctx.meta.runId;

          const results = await Promise.all(
            counts.map(async (count, jobIndex) => {
              const req: MediaRequest = { ...base, count };
              const fingerprint = fingerprintRequest(provider.name, req, jobIndex);
              const mctx: MediaCallContext = {
                secrets: ctx.secrets,
                signal: ctx.signal,
                logger: ctx.logger,
                fetch: callFetch,
                saveOutput: createOutputWriter({
                  workspace: ctx.workspace,
                  scope: jobScope,
                  nodeId,
                  jobKey: fingerprint,
                  fetchImpl: callFetch,
                  signal: ctx.signal,
                  provenance: {
                    provider: provider.name,
                    vendor: provider.vendor,
                    ...(model ? { model } : {}),
                    ...(base.prompt ? { prompt: base.prompt.slice(0, 500) } : {}),
                  },
                }),
              };
              return runMediaJob({
                provider,
                req,
                mctx,
                journal: createFileJournal({ workspace: ctx.workspace, scope: jobScope, nodeId, fingerprint }),
                workspace: ctx.workspace,
                timeout: config.timeout ?? spec.defaultTimeout,
                emit: (phase, data) => ctx.emit("custom.media.job", { nodeId, modality, phase, ...data }),
              });
            }),
          );

          const artifacts: Artifact[] = results.flatMap((r) => r.artifacts);
          const costUSD = results.reduce((sum, r) => sum + r.costUSD, 0);
          if (costUSD > 0) enforceBudget(ctx, { costUSD });

          const output = {
            artifact: artifacts[0],
            artifacts,
            count: artifacts.length,
            provider: provider.name,
            vendor: provider.vendor,
            ...(model ? { model } : {}),
            costUSD,
            reused: results.every((r) => r.reused),
          };
          ctx.emit("node.output", output);
          return { update: applyOutput(config.output, output, { nodeId, scope }) };
        },
      };
    },
  });
}

export const imageNode = buildMediaNode(MODALITIES.image);
export const videoNode = buildMediaNode(MODALITIES.video);
export const model3dNode = buildMediaNode(MODALITIES.model3d);
export const audioNode = buildMediaNode(MODALITIES.audio);
