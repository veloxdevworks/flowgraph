/**
 * Generative media contract (image / video / model3d).
 *
 * A `MediaProvider` is deliberately NOT a `ProviderAdapter`: media generation
 * is a (possibly long) job, not an agent loop. See ADR-0017.
 */

import type { Artifact } from "@flowgraph/spec";
import type { Logger } from "../context.js";
import type { SecretProvider } from "../secrets.js";

export type MediaModality = "image" | "video" | "model3d" | "audio";

/** A resolved reference input (image-to-video, image-to-3D, edit, ...). */
export interface MediaInput {
  /** Human-readable origin, for logs and fingerprints (never contains bytes). */
  ref: string;
  mimeType: string;
  /** Absolute path when the input is a local file. */
  filePath?: string | undefined;
  /** http(s) URL when the input is remote; a vendor may pass it through untouched. */
  url?: string | undefined;
  /** Stable identity for fingerprinting: sha256 / size for files, the URL for remote inputs. */
  identity: string;
  /** The producing node's artifact, when the input came from one. */
  artifact?: Artifact | undefined;
  bytes(): Promise<Uint8Array>;
  /** `data:<mime>;base64,...` form. */
  dataUri(): Promise<string>;
}

export interface MediaRequest {
  modality: MediaModality;
  model?: string | undefined;
  prompt?: string | undefined;
  negativePrompt?: string | undefined;
  inputs: MediaInput[];
  /** Outputs wanted from THIS job (the node splits larger counts by `maxPerJob`). */
  count: number;
  size?: string | undefined;
  aspectRatio?: string | undefined;
  quality?: string | undefined;
  seed?: number | undefined;
  /** Seconds (video). */
  duration?: number | undefined;
  resolution?: string | undefined;
  /** audio: speech | sfx | music */
  audioKind?: "speech" | "sfx" | "music" | undefined;
  /** audio: the script to speak (speech) or lyrics (music) */
  text?: string | undefined;
  voice?: string | undefined;
  language?: string | undefined;
  instrumental?: boolean | undefined;
  /** model3d */
  mode?: "text" | "image" | "multiview" | undefined;
  format?: string | undefined;
  texture?: boolean | undefined;
  /** Vendor passthrough. */
  params: Record<string, unknown>;
}

/** A produced file, before it is saved into the artifact store. */
export type MediaOutput =
  | { bytes: Uint8Array; mimeType: string; meta?: Artifact["meta"] }
  | { url: string; mimeType?: string; headers?: Record<string, string>; meta?: Artifact["meta"] };

export interface MediaCallContext {
  secrets: SecretProvider;
  signal?: AbortSignal | undefined;
  logger: Logger;
  /** `fetch` to use for vendor calls and downloads (tests inject a fake). */
  fetch: typeof fetch;
  /**
   * Persist a produced file into the run's artifact store and get its
   * Artifact. File names are deterministic per job, so re-running the same
   * fetch overwrites rather than duplicates.
   */
  saveOutput(out: MediaOutput): Promise<Artifact>;
}

/**
 * Opaque, JSON-serializable job handle. It is written to the job journal the
 * moment the vendor accepts the job, so a crashed or retried node re-attaches
 * instead of submitting (and paying for) a second job.
 */
export interface JobHandle {
  id: string;
  /** Set by vendors whose call is synchronous: the finished artifacts. */
  done?: Artifact[];
  [extra: string]: unknown;
}

export type JobState = "queued" | "running" | "done" | "failed" | "canceled";

export interface JobStatus {
  state: JobState;
  /** 0..100 when the vendor reports it. */
  progress?: number;
  error?: string;
  /** Actual cost, when the vendor reports it. */
  costUSD?: number;
}

export interface MediaProvider {
  /** Name graphs reference (`provider:` on the node). */
  name: string;
  /** Vendor id (`xai`, `openai`, `tripo`, ...). */
  vendor: string;
  modalities: readonly MediaModality[];
  /** audio only: which kinds this provider can make (default: all of speech, sfx, music). */
  audioKinds?: readonly ("speech" | "sfx" | "music")[] | undefined;
  /** Models worth listing in UIs / validation. Informational. */
  models?: Partial<Record<MediaModality, readonly string[]>> | undefined;
  /** Max outputs one job can produce, per modality (default 1). The node splits larger counts. */
  maxPerJob?: Partial<Record<MediaModality, number>> | undefined;
  /** Poll interval hint in ms (default: 2s growing to 10s). */
  pollIntervalMs?: number | undefined;

  /** Submit a job. Synchronous vendors save outputs here and return `{ id, done }`. */
  start(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle>;
  /** Check a job. Not needed when `start` always returns `done`. */
  poll?(handle: JobHandle, ctx: MediaCallContext): Promise<JobStatus>;
  /** Collect a finished job's outputs via `ctx.saveOutput`. */
  fetch?(handle: JobHandle, ctx: MediaCallContext): Promise<Artifact[]>;
  /** Best-effort cancel (called on abort). */
  cancel?(handle: JobHandle, ctx: MediaCallContext): Promise<void>;
  /** Cost estimate for budget accounting, before/without a vendor-reported cost. */
  estimateCostUSD?(req: MediaRequest): number | undefined;
}

/** What a vendor factory receives: one `providers:` entry's connection settings. */
export interface MediaVendorOptions {
  /** Name the resulting provider is registered under. */
  name: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  /** Env var holding the API key (resolved at call time through `ctx.secrets`). */
  apiKeyEnv?: string | undefined;
  options?: Record<string, unknown> | undefined;
}

export interface MediaVendor {
  vendor: string;
  modalities: readonly MediaModality[];
  /** Env var tried when the entry sets no `apiKeyEnv`. */
  defaultApiKeyEnv?: string | undefined;
  create(opts: MediaVendorOptions): MediaProvider;
}
