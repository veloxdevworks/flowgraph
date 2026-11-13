/**
 * Tripo3D (3D asset generation) adapter, Tripo API v3.
 *
 * Doc URLs used (read 2026-11-05; the pages are served as markdown by appending
 * `.md`, e.g. https://developers.tripo3d.ai/en/docs/quick-start.md):
 *   https://developers.tripo3d.ai/llms.txt                              (index)
 *   https://developers.tripo3d.ai/en/docs/introduction                  (base URL, auth, envelope, statuses)
 *   https://developers.tripo3d.ai/en/docs/quick-start
 *   https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard   (H series, also /p)
 *   https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard
 *   https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard
 *   https://developers.tripo3d.ai/en/docs/models-convert                (format conversion)
 *   https://developers.tripo3d.ai/en/docs/files                         (multipart upload -> file_token)
 *   https://developers.tripo3d.ai/en/docs/task-query                    (GET /v3/tasks/{id}, credits_consumed)
 *   https://developers.tripo3d.ai/en/docs/task-lifecycle
 *   https://developers.tripo3d.ai/en/docs/models-and-versions
 *   https://developers.tripo3d.ai/en/docs/error-handling
 *   https://developers.tripo3d.ai/en/docs/rate-limits
 *   https://developers.tripo3d.ai/en/docs/billing                       (1 credit = $0.01)
 *   https://developers.tripo3d.ai/en/pricing                            (credits per operation)
 *   https://developers.tripo3d.ai/en/docs/sdk                           (model URLs are temporary signed URLs)
 *   https://developers.tripo3d.ai/en/docs/migration-v2-to-v3
 *
 * Verified from docs (NOT live-verified: no API key was available, no call was ever made):
 *   - Base URL https://openapi.tripo3d.ai/v3, header `Authorization: Bearer <key>`.
 *   - Per-operation endpoints: POST /generation/text-to-model | image-to-model | multiview-to-model;
 *     POST /files (multipart field `file`, images PNG/JPEG, 20 MB) -> data.file_token;
 *     POST /models/convert (input = task_id, format GLTF|FBX|USDZ|OBJ|STL|3MF); GET /tasks/{task_id}.
 *   - Success envelope `{code:0,data:{...}}`; error envelope `{code,message,suggestion,request_id}`
 *     (e.g. 2010 = insufficient credits, HTTP 403; 1007 rate limit and 2000 concurrency limit, HTTP 429).
 *   - Task statuses: queued, running, success, failed, cancelled (legacy banned/expired = terminal failure;
 *     other values such as `unknown` must not be treated as success or failure). `progress` is 0-100.
 *   - Failure detail in `error_code` / `error_message`; actual cost in `credits_consumed` (credits, may be
 *     fractional); 1 credit = $0.01.
 *   - `model` is REQUIRED on all three generation endpoints. Default chosen: v3.1-20260211 ("recommended").
 *   - Output: `output.model_url` (GLB by default) and `output.rendered_image_url`; `quad: true` forces FBX.
 *   - Model URLs are temporary signed URLs, downloaded without the Authorization header (sdk page).
 *   - `pbr: true` forces `texture: true`, so "no texture" must send both `texture:false` and `pbr:false`.
 *   - `negative_prompt` exists on text-to-model only; image/multiview have no prompt.
 *   - Multiview: `inputs` = view-key objects (front, left, back, right); front required, >= 2 images.
 *   - No cancel endpoint and no idempotency key are documented, so `cancel` is not implemented.
 *   - Concurrency: default 10 running H-series generation tasks per account, 5 for P series.
 *
 * Assumed (not stated by the docs):
 *   - The exact lifetime of model URLs (earlier unverified search snippets said ~5 minutes). `fetch`
 *     therefore re-queries the task and downloads at once; it never reuses a URL seen earlier.
 *   - Multiview input order: the node's ordered inputs are mapped to [front, left, back, right].
 *   - The convert output (`output.model_url` of the convert task) is one downloadable file per format
 *     (GLTF/OBJ may in reality be an archive); its file extension then depends on the URL.
 *   - Estimated cost covers H-series models only (see estimateCostUSD); P-series prices were not readable.
 *
 * Provider options (`providers.<name>.options`):
 *   params               default request-body fields, merged before the node's `params`
 *   convertParams        extra body fields for POST /models/convert (e.g. texture_size)
 *   savePreview          true: also save `rendered_image_url` and link it as meta.thumbnail (default false)
 *   convertPollIntervalMs / convertTimeoutMs   convert wait loop inside fetch (default 2000 / 300000)
 */

import type {
  JobHandle,
  JobStatus,
  MediaCallContext,
  MediaInput,
  MediaModality,
  MediaProvider,
  MediaRequest,
  MediaVendor,
  MediaVendorOptions,
} from "@flowgraph/core";
import { joinUrl, requestJson, resolveApiKey, VendorHttpError } from "../http.js";

type Artifact = Awaited<ReturnType<MediaCallContext["saveOutput"]>>;

const VENDOR = "tripo";
const DEFAULT_BASE_URL = "https://openapi.tripo3d.ai/v3";
const DEFAULT_MODEL = "v3.1-20260211";
const KNOWN_MODELS = ["v3.1-20260211", "v3.0-20250812", "v2.5-20250123", "P2-20260801", "P1-20260311"] as const;
const MODALITIES: readonly MediaModality[] = ["model3d"];

/** Documented: 1 credit = $0.01 (billing page). */
const USD_PER_CREDIT = 0.01;
/** Pricing page: "Format Convert (Basic)" 5 credits. */
const CONVERT_BASIC_CREDITS = 5;

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const VIEW_KEYS = ["front", "left", "back", "right"] as const;
const TEXTURE_QUALITIES = ["fast", "standard", "detailed", "extreme"] as const;
const FAST_TEXTURE_VERSION = "v3.5-20260815";

/** Output formats: `glb` is native; the rest need POST /models/convert. */
const CONVERT_FORMATS: Record<string, string> = {
  gltf: "GLTF",
  fbx: "FBX",
  usdz: "USDZ",
  obj: "OBJ",
  stl: "STL",
  "3mf": "3MF",
};
const SUPPORTED_FORMATS = ["glb", ...Object.keys(CONVERT_FORMATS)].join(", ");
const FORMAT_MIME: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  fbx: "application/octet-stream",
  obj: "model/obj",
  stl: "model/stl",
  usdz: "model/vnd.usdz+zip",
  "3mf": "model/3mf",
};

type Endpoint = "text-to-model" | "image-to-model" | "multiview-to-model";

interface TripoTask {
  task_id?: string;
  type?: string;
  status?: string;
  progress?: number;
  output?: Record<string, unknown>;
  error_code?: number;
  error_message?: string;
  credits_consumed?: number;
  created_at?: string;
  completed_at?: string;
}

interface Envelope<T> {
  code?: number;
  data?: T;
  message?: string;
  suggestion?: string;
  request_id?: string;
}

/** What `start` stores in the journal (JSON). */
interface TripoHandle extends JobHandle {
  id: string;
  endpoint: Endpoint;
  model: string;
  /** Final file format delivered to the node. */
  outputFormat: string;
  /** Set when `fetch` must run POST /models/convert first. */
  convertTo?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Re-throw a non-2xx as a VendorHttpError whose text is Tripo's own `[code] message`. */
function describeApiError(err: VendorHttpError): VendorHttpError {
  try {
    const j = JSON.parse(err.body) as Envelope<unknown>;
    if (typeof j.message === "string") {
      const parts = [`${typeof j.code === "number" ? `[${j.code}] ` : ""}${j.message}`];
      if (j.suggestion) parts.push(`(${j.suggestion})`);
      if (j.request_id) parts.push(`request_id ${j.request_id}`);
      return new VendorHttpError(VENDOR, err.status, parts.join(" "));
    }
  } catch {
    /* body was clipped or not JSON: keep it as is */
  }
  return err;
}

/** One API call: auth header, JSON envelope unwrapped, errors surfaced with Tripo's message. */
async function api<T>(
  ctx: MediaCallContext,
  key: string,
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<T> {
  let env: Envelope<T>;
  try {
    env = await requestJson<Envelope<T>>(ctx, url, {
      vendor: VENDOR,
      method,
      headers: { Authorization: `Bearer ${key}` },
      ...(body !== undefined ? { body } : {}),
    });
  } catch (err) {
    throw err instanceof VendorHttpError ? describeApiError(err) : err;
  }
  if (typeof env.code === "number" && env.code !== 0) {
    throw new Error(
      `${VENDOR}: API error [${env.code}] ${env.message ?? "unknown"}${env.suggestion ? ` (${env.suggestion})` : ""}`,
    );
  }
  if (env.data === undefined) throw new Error(`${VENDOR}: response from ${new URL(url).pathname} had no data`);
  return env.data;
}

function normalizeState(status: string | undefined): JobStatus["state"] | "unknown" {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "success":
      return "done";
    case "failed":
    case "banned":
    case "expired":
      return "failed";
    case "cancelled":
    case "canceled":
      return "canceled";
    default:
      return "unknown";
  }
}

function failureText(task: TripoTask): string {
  const msg = task.error_message?.trim();
  const code = typeof task.error_code === "number" ? ` (error_code ${task.error_code})` : "";
  return msg ? `${msg}${code}` : `task ended with status "${task.status ?? "unknown"}"${code}`;
}

function creditsUSD(credits: number | undefined): number | undefined {
  return typeof credits === "number" && Number.isFinite(credits) && credits >= 0
    ? Math.round(credits * USD_PER_CREDIT * 10000) / 10000
    : undefined;
}

/** Fields shared by the three generation endpoints, before mode-specific fields and `params`. */
function commonBody(req: MediaRequest, model: string, logger?: MediaCallContext["logger"]): Record<string, unknown> {
  const body: Record<string, unknown> = { model };
  if (req.texture === false) {
    // pbr defaults to true and forces texture on, so both must be switched off.
    body["texture"] = false;
    body["pbr"] = false;
  } else if (req.texture === true) {
    body["texture"] = true;
  }
  if (req.seed !== undefined) body["model_seed"] = req.seed;

  const q = req.quality?.trim().toLowerCase();
  if (q) {
    if (/^\d+$/.test(q)) {
      body["face_limit"] = Number(q);
    } else if ((TEXTURE_QUALITIES as readonly string[]).includes(q)) {
      if (req.texture === false) {
        logger?.debug(`${VENDOR}: quality "${q}" ignored because texture is off`);
      } else {
        body["texture_quality"] = q;
        // Docs: `fast` only exists on the v3.5 texture model; any other version returns error 1004.
        if (q === "fast") body["texture_version"] = FAST_TEXTURE_VERSION;
      }
    } else {
      throw new Error(
        `${VENDOR}: unsupported quality "${req.quality}". Use ${TEXTURE_QUALITIES.join("|")} (texture quality) ` +
          `or a number (face_limit). Use params for geometry_quality.`,
      );
    }
  }
  return body;
}

function targetFormat(
  rawFormat: string | undefined,
  body: Record<string, unknown>,
): { outputFormat: string; convertTo?: string } {
  const f = rawFormat?.trim().toLowerCase();
  const quad = body["quad"] === true;
  if (f && f !== "glb" && !CONVERT_FORMATS[f]) {
    throw new Error(`${VENDOR}: unsupported format "${rawFormat}". Supported: ${SUPPORTED_FORMATS}.`);
  }
  if (quad) {
    // Docs: quad=true forces FBX output; GLB cannot be produced from it.
    if (!f) return { outputFormat: "fbx" };
    if (f === "glb") {
      throw new Error(`${VENDOR}: quad meshes are exported as FBX by Tripo; set format to fbx (or drop quad) instead of glb.`);
    }
    if (f === "fbx") return { outputFormat: "fbx" };
    return { outputFormat: f, convertTo: CONVERT_FORMATS[f]! };
  }
  if (!f || f === "glb") return { outputFormat: "glb" };
  return { outputFormat: f, convertTo: CONVERT_FORMATS[f]! };
}

/** Credits for one H-series job from the public price list; undefined when not derivable. */
function estimateCredits(req: MediaRequest, model: string, params: Record<string, unknown>): number | undefined {
  if (/^p\d/i.test(model)) return undefined; // P-series prices were not readable from the docs
  if (!req.mode && req.inputs.length > 1) return undefined;
  const mode = req.mode ?? (req.inputs.length === 0 ? "text" : "image");
  const body = { ...commonBody(req, model), ...params };
  const textured = body["texture"] !== false && body["pbr"] !== false;
  let credits = mode === "text" ? (textured ? 20 : 10) : textured ? 30 : 20;
  if (textured) {
    if (body["texture_quality"] === "detailed") credits += 10;
    if (body["texture_quality"] === "extreme") credits += 20;
  }
  if (body["geometry_quality"] === "detailed") credits += 20;
  if (body["quad"] === true) credits += 5;
  if (body["smart_low_poly"] === true) credits += 10;
  if (body["generate_parts"] === true) credits += 20;
  if (targetFormat(req.format, body).convertTo) credits += CONVERT_BASIC_CREDITS;
  return credits;
}

async function uploadImage(ctx: MediaCallContext, key: string, base: string, input: MediaInput): Promise<string> {
  const mime = input.mimeType.split(";")[0]!.trim().toLowerCase();
  const ext = IMAGE_MIME_EXT[mime === "image/jpg" ? "image/jpeg" : mime];
  if (!ext) {
    throw new Error(`${VENDOR}: input "${input.ref}" is ${input.mimeType}; Tripo accepts PNG, JPEG or WebP images.`);
  }
  const bytes = await input.bytes();
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`${VENDOR}: input "${input.ref}" is ${bytes.byteLength} bytes; the upload limit is 20 MB.`);
  }
  const form = new FormData();
  form.append("file", new Blob([bytes as unknown as ArrayBuffer], { type: mime }), `input.${ext}`);
  const data = await api<{ file_token?: string }>(ctx, key, joinUrl(base, "files"), "POST", form);
  if (!data.file_token) throw new Error(`${VENDOR}: file upload returned no file_token`);
  return data.file_token;
}

/** URL when the input is remote, else an uploaded file_token. */
async function imageRef(ctx: MediaCallContext, key: string, base: string, input: MediaInput): Promise<string> {
  if (input.url && /^https?:\/\//i.test(input.url)) return input.url;
  return uploadImage(ctx, key, base, input);
}

function pickModelUrl(output: Record<string, unknown> | undefined): string | undefined {
  // `model` and `pbr_model` are compatibility aliases of `model_url` (sdk page).
  for (const k of ["model_url", "pbr_model", "model"]) {
    const v = output?.[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export const tripoVendor: MediaVendor = {
  vendor: VENDOR,
  modalities: MODALITIES,
  defaultApiKeyEnv: "TRIPO_API_KEY",
  create(opts: MediaVendorOptions): MediaProvider {
    const base = opts.baseUrl ?? DEFAULT_BASE_URL;
    const o = opts.options ?? {};
    const defaultParams = isRecord(o["params"]) ? o["params"] : {};
    const convertParams = isRecord(o["convertParams"]) ? o["convertParams"] : {};
    const savePreview = o["savePreview"] === true;
    const convertPollMs = typeof o["convertPollIntervalMs"] === "number" ? o["convertPollIntervalMs"] : 2000;
    const convertTimeoutMs = typeof o["convertTimeoutMs"] === "number" ? o["convertTimeoutMs"] : 300_000;

    const modelFor = (req: MediaRequest) => req.model ?? opts.model ?? DEFAULT_MODEL;
    const keyFor = (ctx: MediaCallContext) => resolveApiKey(VENDOR, ctx, [opts.apiKeyEnv, "TRIPO_API_KEY"]);
    const getTask = (ctx: MediaCallContext, key: string, id: string) =>
      api<TripoTask>(ctx, key, joinUrl(base, `tasks/${encodeURIComponent(id)}`), "GET");

    /** Run POST /models/convert on a finished generation task and wait for it. */
    async function convert(ctx: MediaCallContext, key: string, handle: TripoHandle): Promise<TripoTask> {
      const created = await api<{ task_id?: string }>(ctx, key, joinUrl(base, "models/convert"), "POST", {
        ...convertParams,
        input: handle.id,
        format: handle.convertTo,
      });
      const convertId = created.task_id;
      if (!convertId) throw new Error(`${VENDOR}: convert returned no task_id`);
      const deadline = Date.now() + convertTimeoutMs;
      for (;;) {
        ctx.signal?.throwIfAborted();
        const t = await getTask(ctx, key, convertId);
        const state = normalizeState(t.status);
        if (state === "done") return { ...t, task_id: convertId };
        if (state === "failed" || state === "canceled") {
          throw new Error(`${VENDOR}: convert to ${handle.convertTo} (task ${convertId}) ${state}: ${failureText(t)}`);
        }
        if (Date.now() + convertPollMs > deadline) {
          throw new Error(`${VENDOR}: convert to ${handle.convertTo} (task ${convertId}) not finished after ${convertTimeoutMs} ms`);
        }
        await sleep(convertPollMs, ctx.signal);
      }
    }

    return {
      name: opts.name,
      vendor: VENDOR,
      modalities: MODALITIES,
      models: { model3d: KNOWN_MODELS },
      pollIntervalMs: 2000, // docs recommend polling every 1-2 s
      // maxPerJob left unset: one model per task, the node splits `count`.

      estimateCostUSD(req) {
        try {
          const credits = estimateCredits(req, modelFor(req), { ...defaultParams, ...req.params });
          return credits === undefined ? undefined : credits * USD_PER_CREDIT;
        } catch {
          return undefined;
        }
      },

      async start(req, ctx): Promise<TripoHandle> {
        if (req.modality !== "model3d") throw new Error(`${VENDOR}: only model3d is supported (got ${req.modality})`);
        const key = await keyFor(ctx);
        const model = modelFor(req);
        const mode = req.mode ?? (req.inputs.length === 0 ? "text" : req.inputs.length === 1 ? "image" : "multiview");
        const body = commonBody(req, model, ctx.logger);
        let endpoint: Endpoint;

        if (mode === "text") {
          endpoint = "text-to-model";
          const prompt = req.prompt?.trim();
          if (!prompt) throw new Error(`${VENDOR}: text mode needs a prompt`);
          if (prompt.length > 1024) throw new Error(`${VENDOR}: prompt is ${prompt.length} characters; the limit is 1024`);
          body["prompt"] = prompt;
          if (req.negativePrompt?.trim()) {
            if (req.negativePrompt.length > 255) {
              throw new Error(`${VENDOR}: negativePrompt is ${req.negativePrompt.length} characters; the limit is 255`);
            }
            body["negative_prompt"] = req.negativePrompt.trim();
          }
        } else {
          if (req.negativePrompt?.trim()) ctx.logger.warn(`${VENDOR}: negativePrompt is only supported in text mode; ignored`);
          if (req.prompt?.trim()) ctx.logger.warn(`${VENDOR}: ${mode}-to-model takes no prompt; ignored`);
          if (mode === "image") {
            endpoint = "image-to-model";
            if (req.inputs.length !== 1) {
              throw new Error(`${VENDOR}: image mode needs exactly one input image (got ${req.inputs.length})`);
            }
            body["input"] = await imageRef(ctx, key, base, req.inputs[0]!);
          } else {
            endpoint = "multiview-to-model";
            if (req.inputs.length < 2 || req.inputs.length > VIEW_KEYS.length) {
              throw new Error(`${VENDOR}: multiview needs 2-4 images ordered front, left, back, right (got ${req.inputs.length})`);
            }
            const refs = await Promise.all(req.inputs.map((i) => imageRef(ctx, key, base, i)));
            body["inputs"] = refs.map((ref, i) => ({ [VIEW_KEYS[i]!]: ref }));
          }
        }

        // `params` shallow-merges last (provider-level defaults first, then the node's).
        Object.assign(body, defaultParams, req.params);
        const { outputFormat, convertTo } = targetFormat(req.format, body);

        const data = await api<{ task_id?: string }>(ctx, key, joinUrl(base, `generation/${endpoint}`), "POST", body);
        if (!data.task_id) throw new Error(`${VENDOR}: ${endpoint} returned no task_id`);
        return {
          id: data.task_id,
          endpoint,
          model: String(body["model"] ?? model),
          outputFormat,
          ...(convertTo ? { convertTo } : {}),
        };
      },

      async poll(handle, ctx): Promise<JobStatus> {
        const key = await keyFor(ctx);
        let task: TripoTask;
        try {
          task = await getTask(ctx, key, handle.id);
        } catch (err) {
          if (err instanceof VendorHttpError && (err.status === 429 || err.status >= 500)) {
            ctx.logger.warn(`${VENDOR}: transient poll error, will retry: ${err.message}`);
            return { state: "running" };
          }
          throw err;
        }
        const state = normalizeState(task.status);
        const progress = typeof task.progress === "number" ? Math.max(0, Math.min(100, task.progress)) : undefined;
        if (state === "unknown") {
          // Docs: other values (e.g. "unknown") are neither success nor failure; keep waiting, the node timeout bounds it.
          ctx.logger.warn(`${VENDOR}: task ${handle.id} has unrecognised status "${task.status}"`);
          return { state: "running", ...(progress !== undefined ? { progress } : {}) };
        }
        if (state === "failed" || state === "canceled") {
          return { state, error: failureText(task), ...(progress !== undefined ? { progress } : {}) };
        }
        if (state === "done") {
          const gen = creditsUSD(task.credits_consumed);
          const conv = (handle as TripoHandle).convertTo ? CONVERT_BASIC_CREDITS * USD_PER_CREDIT : 0;
          return { state, progress: 100, ...(gen !== undefined ? { costUSD: gen + conv } : {}) };
        }
        return { state, ...(progress !== undefined ? { progress } : {}) };
      },

      async fetch(handle, ctx): Promise<Artifact[]> {
        const h = handle as TripoHandle;
        const key = await keyFor(ctx);
        // Always re-query: the model URL is a temporary signed URL, so use the freshest one and download now.
        const gen = await getTask(ctx, key, h.id);
        if (normalizeState(gen.status) !== "done") {
          throw new Error(`${VENDOR}: task ${h.id} is "${gen.status}", not finished; cannot fetch`);
        }
        let out = gen;
        let convertTaskId: string | undefined;
        if (h.convertTo) {
          out = await convert(ctx, key, h);
          convertTaskId = out.task_id;
        }
        const url = pickModelUrl(out.output);
        if (!url) throw new Error(`${VENDOR}: task ${out.task_id ?? h.id} succeeded but has no output.model_url`);

        const credits = (out === gen ? [gen.credits_consumed] : [gen.credits_consumed, out.credits_consumed]).filter((c): c is number => typeof c === "number");
        const totalCredits = credits.length ? credits.reduce((a, b) => a + b, 0) : undefined;
        const costUSD = creditsUSD(totalCredits);
        const mimeType = FORMAT_MIME[h.outputFormat] ?? "application/octet-stream";
        const model = await ctx.saveOutput({
          url,
          mimeType,
          ext: h.outputFormat,
          meta: {
            ...(costUSD !== undefined ? { costUSD } : {}),
            tripo: {
              taskId: h.id,
              type: gen.type ?? null,
              model: h.model,
              format: h.outputFormat,
              creditsConsumed: totalCredits ?? null,
              convertTaskId: convertTaskId ?? null,
            },
          },
        });

        const previewUrl = gen.output?.["rendered_image_url"];
        if (savePreview && typeof previewUrl === "string" && previewUrl) {
          try {
            const preview = await ctx.saveOutput({ url: previewUrl });
            model.meta = { ...(model.meta ?? {}), thumbnail: preview.path };
          } catch (err) {
            ctx.logger.warn(`${VENDOR}: preview image not saved: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return [model];
      },
    };
  },
};
