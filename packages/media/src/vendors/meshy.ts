/**
 * Meshy (3D asset generation) media vendor.
 *
 * Docs read on 2026-11-05 (OpenAPI spec + per-endpoint markdown, all official):
 *   - https://docs.meshy.ai/llms.txt                       (LLM guide, rate limits, status semantics)
 *   - https://docs.meshy.ai/openapi.yaml                   (machine-readable contract)
 *   - https://docs.meshy.ai/api/authentication.md
 *   - https://docs.meshy.ai/api/text-to-3d.md              (preview + refine, GET, DELETE)
 *   - https://docs.meshy.ai/api/image-to-3d.md
 *   - https://docs.meshy.ai/api/multi-image-to-3d.md
 *   - https://docs.meshy.ai/api/pricing.md
 *   - https://docs.meshy.ai/api/errors.md
 *   - https://docs.meshy.ai/api/task-lifecycle.md
 *   - https://docs.meshy.ai/api/asset-retention.md
 *   - https://docs.meshy.ai/api/rate-limits.md
 *
 * NOT live-verified: this adapter has never made a real API call. Meshy's
 * shared "test-mode" API key, which returned a fixed sample model without using
 * credits, was RETIRED (changelog, 2026-09-16: requests that still send it get
 * 401). To try the real API, create your own key at
 * https://www.meshy.ai/developers/keys (paid plan required).
 *
 * Verified from docs
 * - Auth: `Authorization: Bearer msy_...` on every request.
 * - Endpoints (base https://api.meshy.ai): POST/GET/DELETE `/openapi/v2/text-to-3d[/{id}]`,
 *   `/openapi/v1/image-to-3d[/{id}]`, `/openapi/v1/multi-image-to-3d[/{id}]`.
 *   POST returns 202 `{ "result": "<task id>" }`; GET returns the task object.
 * - Status strings: PENDING, IN_PROGRESS, SUCCEEDED, FAILED, CANCELED (a task can step back from
 *   IN_PROGRESS to PENDING with progress restarting at 0). `progress` is 0..100.
 *   `task_error` is `{ type, code?, message, doc_url? }` on FAILED; failed tasks are refunded.
 * - Output: `model_urls` keyed by format (glb, fbx, obj, usdz, stl, ...), signed assets.meshy.ai URLs
 *   that need no auth header. Assets are kept at most 3 days (non-Enterprise), so this adapter
 *   downloads inside fetch(), right after the job reports done.
 * - `target_formats` (glb|obj|fbx|stl|usdz|3mf) limits what Meshy generates; by default it makes
 *   every format except 3mf. Text to 3D is two requests: `mode: preview` (untextured mesh) then
 *   `mode: refine` with `preview_task_id` (texture), billed separately.
 * - Image inputs: public http(s) URL or base64 data URI (jpg/jpeg/png/webp, <= 20 MB, >= 32 px).
 *   Multi-image takes 1-4 images (first is the front view).
 * - DELETE on a PENDING task cancels and refunds; on IN_PROGRESS it returns 409 and the task keeps
 *   running (so cancel() is only effective while a task is still queued). No other cancel exists.
 * - Credits (https://docs.meshy.ai/api/pricing.md): Text to 3D preview 20 (meshy-7.1/latest, meshy-6)
 *   or 5 (meshy-6-lite, meshy-t2, meshy-t2.5); refine 10 (2K/4K) or 15 (8K). Image to 3D and
 *   Multi-Image to 3D: mesh only 20 (5 on lite), with 2K/4K textures 30 (15 on lite), 8K 35.
 *   Ultra geometry +5. The docs publish NO price per credit, so `estimateCostUSD` is deliberately
 *   not implemented and no costUSD is reported.
 * - Rate limits: 20 req/s on most plans; concurrent PENDING+IN_PROGRESS tasks 10 (Pro) to 100;
 *   429 on excess. A failed/429/5xx status request is not a task failure, so poll() treats those as
 *   "still running". Recommended poll interval is Retry-After or 5 s (this adapter uses 5 s).
 * - There is no idempotency key on create, and the docs say never to resend a create after a
 *   timeout or 5xx (the task may exist). A 4xx means no task was created.
 *
 * Assumed (not stated or not testable from docs)
 * - `negative_prompt` and `seed` are accepted on Text to 3D (they appear in the OpenAPI schema but
 *   not on the markdown page); they are only sent when the request sets them. Image to 3D and
 *   Multi-Image to 3D document neither, so they are not sent there.
 * - Sending `target_formats: [<requested format>]` on the final stage is accepted for every
 *   endpoint (documented for text-to-3d; same enum in the other two schemas).
 * - The preview stage's `target_formats` is left at the default when a refine follows, because the
 *   docs do not say whether refine reads the preview's exported files.
 * - `quality` "2k" | "4k" | "8k" maps to `texture_resolution`; other values are ignored with a warning.
 *
 * Two-stage Text to 3D as ONE flowgraph job
 * The job handle is `{ id, kind, stage, previewId, refineId, refine, format }`. `id` is the task of
 * the stage currently running. poll() advances the machine: when the preview SUCCEEDS and texturing
 * is wanted it creates the refine task and, in the SAME call, returns
 * `{ state: "running", handle: { ...handle, stage: "refine", id: refineId, refineId } }`, which the
 * engine journals before polling continues. A crash after that re-attaches to the refine stage and
 * cannot create a second paid refine. The residual window is the milliseconds between Meshy
 * accepting the refine create and the engine's journal write. A refine create that fails with 5xx
 * or a network error is NOT retried automatically (the task might exist and there is no
 * idempotency key); it surfaces as an error instead.
 *
 * Options (provider entry `options:`): `pollIntervalMs` (default 5000), `enablePbr` (default false).
 * `req.params` is shallow-merged into the create body last. For the two-stage text pipeline the
 * keys are routed by stage (enable_pbr, texture_resolution, hd_texture, texture_prompt,
 * texture_image_url, remove_lighting -> refine; target_formats, moderation, alpha_thumbnail -> both;
 * auto_size, origin_at -> the final stage; everything else -> preview). `params.preview` and
 * `params.refine` (objects) are merged last into their stage's body, e.g.
 * `params: { refine: { ai_model: "meshy-n1" } }`.
 */

import type {
  JobHandle,
  JobStatus,
  MediaCallContext,
  MediaProvider,
  MediaRequest,
  MediaVendor,
  MediaVendorOptions,
} from "@flowgraph/core";
import { VendorHttpError, joinUrl, requestJson, resolveApiKey } from "../http.js";

const VENDOR = "meshy";
const DEFAULT_BASE_URL = "https://api.meshy.ai";
const DEFAULT_API_KEY_ENV = "MESHY_API_KEY";
const DEFAULT_POLL_MS = 5000;
const DEFAULT_FORMAT = "glb";

type Kind = "text" | "image" | "multiview";
type Stage = "preview" | "refine" | "single";

const TASK_PATH: Record<Kind, string> = {
  text: "openapi/v2/text-to-3d",
  image: "openapi/v1/image-to-3d",
  multiview: "openapi/v1/multi-image-to-3d",
};

/** Formats Meshy documents for `target_formats` / `model_urls` on these three endpoints. */
const FORMAT_MIME: Record<string, string> = {
  glb: "model/gltf-binary",
  fbx: "application/octet-stream",
  obj: "model/obj",
  usdz: "model/vnd.usdz+zip",
  stl: "model/stl",
  "3mf": "model/3mf",
};

const REFINE_ONLY = new Set(["enable_pbr", "texture_resolution", "hd_texture", "texture_prompt", "texture_image_url", "remove_lighting"]);
const BOTH_STAGES = new Set(["target_formats", "moderation", "alpha_thumbnail"]);
const FINAL_STAGE = new Set(["auto_size", "origin_at"]);

interface MeshyHandle extends JobHandle {
  kind: Kind;
  stage: Stage;
  /** Text to 3D only. */
  previewId?: string;
  refineId?: string;
  /** Text to 3D only: body (minus mode / preview_task_id) of the refine request; absent when untextured. */
  refine?: Record<string, unknown>;
  format: string;
}

interface MeshyTaskError {
  type?: string;
  code?: string;
  message?: string;
}

interface MeshyTask {
  id?: string;
  status?: string;
  progress?: number;
  task_error?: MeshyTaskError | null;
  model_urls?: Record<string, string | undefined>;
  consumed_credits?: number | null;
}

function normalizeFormat(raw: string | undefined): string {
  const f = (raw ?? DEFAULT_FORMAT).trim().toLowerCase().replace(/^\./, "");
  if (!(f in FORMAT_MIME)) {
    throw new Error(
      `meshy: unsupported 3D format "${raw}". Text/Image/Multi-Image to 3D can export: ${Object.keys(FORMAT_MIME).join(", ")}.`,
    );
  }
  return f;
}

function pickMode(req: MediaRequest): Kind {
  const mode = req.mode ?? (req.inputs.length === 0 ? "text" : req.inputs.length === 1 ? "image" : "multiview");
  return mode;
}

/** Turn a Meshy `{ "message": "..." }` error body into a readable error; keep the status. */
function friendly(err: unknown): unknown {
  if (!(err instanceof VendorHttpError)) return err;
  let message = err.body;
  try {
    const parsed = JSON.parse(err.body) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
  } catch {
    // body was clipped or not JSON: keep it as is
  }
  const hint =
    err.status === 401
      ? " (check the Meshy API key; the retired shared test key also gives 401)"
      : err.status === 402
        ? " (insufficient credits, or a plan without API task creation)"
        : "";
  return new VendorHttpError(VENDOR, err.status, `${message}${hint}`);
}

/** A status request that failed this way says nothing about the task itself. */
function isTransient(err: unknown): boolean {
  if (err instanceof VendorHttpError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError; // fetch network failure
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeTaskError(e: MeshyTaskError | null | undefined): string {
  if (!e) return "task failed without details";
  const head = e.code ? `[${e.code}] ` : e.type ? `[${e.type}] ` : "";
  return `${head}${e.message ?? "task failed"}`;
}

function mapStatus(status: string | undefined): JobStatus["state"] | undefined {
  switch (status) {
    case "PENDING":
      return "queued";
    case "IN_PROGRESS":
      return "running";
    case "SUCCEEDED":
      return "done";
    case "FAILED":
      return "failed";
    case "CANCELED":
      return "canceled";
    default:
      return undefined;
  }
}

function clampProgress(p: unknown): number | undefined {
  return typeof p === "number" && Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : undefined;
}

function readHandle(h: JobHandle): MeshyHandle {
  const kind = h["kind"];
  const stage = h["stage"];
  if ((kind !== "text" && kind !== "image" && kind !== "multiview") || (stage !== "preview" && stage !== "refine" && stage !== "single")) {
    throw new Error(`meshy: job handle ${h.id} is not a Meshy handle (missing kind/stage)`);
  }
  return h as MeshyHandle;
}

/** Split `req.params` for the two-stage text pipeline. */
function routeTextParams(
  params: Record<string, unknown>,
  textured: boolean,
  logger: MediaCallContext["logger"],
): { preview: Record<string, unknown>; refine: Record<string, unknown> } {
  const preview: Record<string, unknown> = {};
  const refine: Record<string, unknown> = {};
  let previewNs: Record<string, unknown> = {};
  let refineNs: Record<string, unknown> = {};
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  for (const [k, v] of Object.entries(params)) {
    if (k === "preview") {
      if (isObj(v)) previewNs = v;
    } else if (k === "refine") {
      if (isObj(v)) refineNs = v;
    } else if (REFINE_ONLY.has(k)) {
      if (textured) refine[k] = v;
      else logger.warn(`meshy: param "${k}" only applies to the texture (refine) stage; ignored because texture is off`);
    } else if (BOTH_STAGES.has(k)) {
      preview[k] = v;
      refine[k] = v;
    } else if (FINAL_STAGE.has(k)) {
      (textured ? refine : preview)[k] = v;
    } else {
      preview[k] = v;
    }
  }
  return { preview: { ...preview, ...previewNs }, refine: { ...refine, ...refineNs } };
}

export const meshyVendor: MediaVendor = {
  vendor: VENDOR,
  modalities: ["model3d"],
  defaultApiKeyEnv: DEFAULT_API_KEY_ENV,

  create(opts: MediaVendorOptions): MediaProvider {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const keyEnvs = [opts.apiKeyEnv, DEFAULT_API_KEY_ENV] as const;
    const pollIntervalMs =
      typeof opts.options?.["pollIntervalMs"] === "number" && opts.options["pollIntervalMs"] > 0
        ? (opts.options["pollIntervalMs"] as number)
        : DEFAULT_POLL_MS;
    const enablePbr = opts.options?.["enablePbr"] === true;

    const url = (kind: Kind, id?: string): string => joinUrl(baseUrl, id ? `${TASK_PATH[kind]}/${encodeURIComponent(id)}` : TASK_PATH[kind]);

    /** One authenticated call; the key is resolved now, never stored or logged. */
    async function call<T>(ctx: MediaCallContext, method: "GET" | "POST" | "DELETE", target: string, body?: unknown): Promise<T> {
      const key = await resolveApiKey(VENDOR, ctx, keyEnvs);
      try {
        return await requestJson<T>(ctx, target, {
          vendor: VENDOR,
          method,
          headers: { Authorization: `Bearer ${key}` },
          ...(body !== undefined ? { body } : {}),
        });
      } catch (err) {
        throw friendly(err);
      }
    }

    async function createTask(ctx: MediaCallContext, kind: Kind, body: Record<string, unknown>): Promise<string> {
      const res = await call<{ result?: unknown }>(ctx, "POST", url(kind), body);
      if (typeof res.result !== "string" || !res.result) {
        throw new Error(`meshy: create response had no task id (expected {"result": "<id>"})`);
      }
      return res.result;
    }

    const getTask = (ctx: MediaCallContext, kind: Kind, id: string): Promise<MeshyTask> => call<MeshyTask>(ctx, "GET", url(kind, id));

    return {
      name: opts.name,
      vendor: VENDOR,
      modalities: ["model3d"],
      models: { model3d: ["latest", "meshy-7.1", "meshy-6", "meshy-6-lite", "meshy-t2.5", "meshy-t2"] },
      maxPerJob: { model3d: 1 },
      pollIntervalMs,

      async start(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
        if (req.modality !== "model3d") throw new Error(`meshy: only model3d is supported (got ${req.modality})`);
        const kind = pickMode(req);
        const format = normalizeFormat(req.format);
        const textured = req.texture !== false;
        const model = req.model ?? opts.model;
        const params = req.params ?? {};

        let qualityRes: string | undefined;
        if (req.quality) {
          const q = req.quality.toLowerCase();
          if (q === "2k" || q === "4k" || q === "8k") qualityRes = q;
          else ctx.logger.warn(`meshy: quality "${req.quality}" is not one of 2k|4k|8k; ignored`);
        }
        const modelFields: Record<string, unknown> = {
          ...(model ? { ai_model: model } : {}),
          ...(model?.startsWith("meshy-t2") ? { model_type: "smart-topology" } : {}),
        };

        if (kind === "text") {
          const prompt = req.prompt?.trim();
          if (!prompt) throw new Error("meshy: text mode needs a prompt");
          const routed = routeTextParams(params, textured, ctx.logger);
          const previewBody: Record<string, unknown> = {
            mode: "preview",
            prompt,
            ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
            ...modelFields,
            ...(textured ? {} : { target_formats: [format] }),
            ...routed.preview,
          };
          let refine: Record<string, unknown> | undefined;
          if (textured) {
            refine = {
              target_formats: [format],
              ...(enablePbr ? { enable_pbr: true } : {}),
              ...(qualityRes ? { texture_resolution: qualityRes } : {}),
              ...routed.refine,
            };
          }
          const previewId = await createTask(ctx, "text", previewBody);
          const handle: MeshyHandle = {
            id: previewId,
            kind,
            stage: "preview",
            previewId,
            format,
            ...(refine ? { refine } : {}),
          };
          return handle;
        }

        // image / multiview: one request, one task.
        const inputs = req.inputs;
        if (kind === "image" && inputs.length !== 1) throw new Error(`meshy: image mode needs exactly one input image (got ${inputs.length})`);
        if (kind === "multiview" && (inputs.length < 1 || inputs.length > 4)) {
          throw new Error(`meshy: multiview mode needs 1-4 input images (got ${inputs.length})`);
        }
        const refs = await Promise.all(inputs.map(async (i) => i.url ?? (await i.dataUri())));
        const body: Record<string, unknown> = {
          ...(kind === "image" ? { image_url: refs[0] } : { image_urls: refs }),
          should_texture: textured,
          ...modelFields,
          target_formats: [format],
          ...(textured && enablePbr ? { enable_pbr: true } : {}),
          ...(textured && qualityRes ? { texture_resolution: qualityRes } : {}),
          ...params,
        };
        const id = await createTask(ctx, kind, body);
        const handle: MeshyHandle = { id, kind, stage: "single", format };
        return handle;
      },

      async poll(raw: JobHandle, ctx: MediaCallContext): Promise<JobStatus> {
        const handle = readHandle(raw);
        const refining = handle.kind === "text" && !!handle.refine;
        // Defensive: a refine id means the refine stage, whatever `stage` says.
        const stage: Stage = handle.refineId ? "refine" : handle.stage;

        let task: MeshyTask;
        try {
          task = await getTask(ctx, handle.kind, handle.refineId ?? handle.id);
        } catch (err) {
          if (isTransient(err)) {
            ctx.logger.warn(`meshy: status request for ${handle.id} failed (${errMsg(err)}); will retry`);
            return { state: "running" };
          }
          throw err;
        }

        const state = mapStatus(task.status);
        if (!state) {
          ctx.logger.warn(`meshy: unknown task status "${String(task.status)}" for ${handle.id}; treating as running`);
          return { state: "running" };
        }
        const reported = clampProgress(task.progress);
        const scale = (p: number | undefined, base: number): number | undefined =>
          p === undefined ? undefined : refining ? base + Math.round(p / 2) : p;
        const progressBase = stage === "refine" ? 50 : 0;
        const progress = scale(reported, progressBase);

        if (state === "failed") {
          const where = refining ? (stage === "refine" ? " (refine stage)" : " (preview stage)") : "";
          return { state: "failed", error: `${describeTaskError(task.task_error)}${where}`, ...(progress !== undefined ? { progress } : {}) };
        }
        if (state === "canceled") {
          return { state: "canceled", error: "task was canceled" };
        }
        if (state !== "done") {
          return { state, ...(progress !== undefined ? { progress } : {}) };
        }

        // SUCCEEDED
        if (stage === "preview" && refining) {
          const previewId = handle.previewId ?? handle.id;
          let refineId: string;
          try {
            refineId = await createTask(ctx, "text", { mode: "refine", preview_task_id: previewId, ...handle.refine });
          } catch (err) {
            if (err instanceof VendorHttpError && err.status === 429) {
              // 4xx: no task was created. Try again on the next poll.
              ctx.logger.warn(`meshy: refine create throttled (${errMsg(err)}); will retry`);
              return { state: "running", progress: 50 };
            }
            if (isTransient(err)) {
              throw new Error(
                `meshy: preview ${previewId} succeeded but creating the refine task failed (${errMsg(err)}). ` +
                  `Meshy has no idempotency key, so the refine task may already exist; it was not retried automatically ` +
                  `to avoid a second charge. Check your recent Text to 3D tasks before re-running.`,
              );
            }
            throw new Error(`meshy: preview ${previewId} succeeded but the refine task could not be created: ${errMsg(err)}`);
          }
          const next: MeshyHandle = { ...handle, stage: "refine", id: refineId, refineId };
          return { state: "running", progress: 50, handle: next };
        }
        return { state: "done", progress: 100 };
      },

      async fetch(raw: JobHandle, ctx: MediaCallContext) {
        const handle = readHandle(raw);
        const finalId = handle.refineId ?? handle.id;
        const task = await getTask(ctx, handle.kind, finalId);
        if (task.status !== "SUCCEEDED") {
          throw new Error(`meshy: task ${finalId} is ${String(task.status)}, not SUCCEEDED; nothing to download`);
        }
        const format = normalizeFormat(handle.format);
        const modelUrl = task.model_urls?.[format];
        if (!modelUrl) {
          const have = Object.entries(task.model_urls ?? {}).filter(([, v]) => !!v).map(([k]) => k);
          throw new Error(
            `meshy: task ${finalId} has no "${format}" output (available: ${have.length ? have.join(", ") : "none"}). ` +
              `Meshy only returns the formats listed in target_formats.`,
          );
        }
        ctx.logger.info("meshy: downloading model", {
          taskId: finalId,
          format,
          ...(typeof task.consumed_credits === "number" ? { consumedCredits: task.consumed_credits } : {}),
        });
        // The signed assets.meshy.ai URL needs no Authorization header (and must never get ours).
        return [await ctx.saveOutput({ url: modelUrl, mimeType: FORMAT_MIME[format] ?? "application/octet-stream" })];
      },

      async cancel(raw: JobHandle, ctx: MediaCallContext): Promise<void> {
        const handle = readHandle(raw);
        const id = handle.refineId ?? handle.id;
        // Called on abort, when ctx.signal is already aborted: use a fresh, short-lived signal.
        const cctx: MediaCallContext = { ...ctx, signal: AbortSignal.timeout(10_000) };
        // DELETE refunds only a PENDING task and 409s on IN_PROGRESS; never delete a finished one.
        const task = await getTask(cctx, handle.kind, id);
        if (task.status !== "PENDING") return;
        try {
          await call(cctx, "DELETE", url(handle.kind, id));
        } catch (err) {
          if (err instanceof VendorHttpError && err.status === 409) return; // started in the meantime
          throw err;
        }
      },
    };
  },
};
