/**
 * xAI (Grok Imagine) media vendor: image generation, image editing, video generation.
 *
 * Sources (official docs, fetched 2026-11-05 as markdown via `<page>.md`; NO live API call was made,
 * there was no API key):
 *   - https://docs.x.ai/developers/model-capabilities/imagine.md
 *   - https://docs.x.ai/developers/model-capabilities/images/generation.md
 *   - https://docs.x.ai/developers/model-capabilities/images/editing.md
 *   - https://docs.x.ai/developers/model-capabilities/images/multi-image-editing.md
 *   - https://docs.x.ai/developers/model-capabilities/video/generation.md
 *   - https://docs.x.ai/developers/model-capabilities/video/overview.md
 *   - https://docs.x.ai/developers/model-capabilities/video/image-to-video.md
 *   - https://docs.x.ai/developers/model-capabilities/video/reference-to-video.md
 *   - https://docs.x.ai/developers/rest-api-reference/inference/images.md
 *   - https://docs.x.ai/developers/rest-api-reference/inference/videos.md
 *   - https://docs.x.ai/developers/models.md (+ models/<model>.md), https://docs.x.ai/developers/pricing.md
 *   - https://docs.x.ai/developers/migration/imagine-image-quality-nov-2.md
 *   - https://docs.x.ai/developers/cost-tracking.md, https://docs.x.ai/developers/rate-limits.md
 *
 * Verified from docs:
 *   - Base URL https://api.x.ai/v1, `Authorization: Bearer <key>`, env var XAI_API_KEY.
 *   - Current image model `grok-imagine-image-2.0` (flagship; `grok-imagine-image` is the older 1.0 model and is
 *     still listed). `grok-imagine-image-quality` was retired 2026-11-02 and is redirected to 2.0 at quality=low.
 *   - Current video models `grok-imagine-video-1.5` (flagship), `grok-imagine-video-1.5-lite`, `grok-imagine-video`.
 *   - POST /images/generations: prompt, n (1-10), aspect_ratio, resolution (1k|2k|1.5k), quality (low|medium|auto,
 *     2.0 only), response_format (url default | b64_json). Response `{ data: [{ url | b64_json, mime_type }], usage }`.
 *     Image URLs are temporary.
 *   - POST /images/edits (JSON, not multipart): `image: {url, type: "image_url"}` for one source, `images: [...]`
 *     for 2-5 (mutually exclusive; refer to them as <IMAGE_0>, <IMAGE_1> in the prompt). `url` is a public URL or a
 *     base64 data URI. Same response shape. Also accepts n, aspect_ratio, resolution, quality, response_format.
 *   - POST /videos/generations -> `{ request_id }`; GET /videos/{request_id} -> `{ status: pending|done|failed,
 *     progress?, video: { url, duration, respect_moderation }, model, usage }`; failed carries
 *     `error: { code, message }` (codes invalid_argument, permission_denied, failed_precondition, service_unavailable,
 *     internal_error). Video URLs are temporary. Fields: prompt, duration (1-15 s, default 8), aspect_ratio,
 *     resolution (480p default | 720p | 1080p), image {url} (image-to-video; output follows the image aspect ratio),
 *     reference_images [{url}] (up to 14 on 1.5, 7 on grok-imagine-video, not on -lite), generate_audio.
 *   - Cost is reported per response in `usage.cost_in_usd_ticks` (1 USD = 1e10 ticks); we surface it from the video
 *     poll as `costUSD`.
 *   - No cancel endpoint is documented for image or video jobs.
 *   - Pricing (models + pricing pages): grok-imagine-image-2.0 $0.04/image, grok-imagine-image $0.02/image,
 *     grok-imagine-video-1.5 $0.080/s, -1.5-lite $0.020/s, grok-imagine-video $0.050/s. Migration page: 2.0 at
 *     quality=low is $0.04 (1K) / $0.06 (2K) per image, plus $0.01 per input image on edits.
 *   - Rate limit per model (models pages / rate-limits page): 6 req/s image, 10 req/s video at tier 0.
 *
 * Assumed / could not confirm:
 *   - Error body shape for non-2xx. Unauthenticated probing of api.x.ai returned
 *     `{"code":"invalid-argument","error":"Incorrect API key ..."}`; the docs don't specify it, so we rely on
 *     VendorHttpError carrying the (clipped) body.
 *   - Whether resolution changes the per-second video price (the overview says it does; the price tables list one
 *     rate), so estimateCostUSD uses the listed rate and the real `usage.cost_in_usd_ticks` replaces it after polling.
 *   - The `medium` image price (not documented), so no image estimate is given for medium/auto-edit/1.5k.
 *   - `expired` is treated as a failure: it appears in one docs shell snippet but not in the status table.
 *   - Image deferred mode (`deferred: true`) is not supported by this adapter; sync generation is used.
 *   - Output mime types: images use the response `mime_type` (docs: image/jpeg unless quality yields PNG); videos
 *     are assumed to be video/mp4 (the upload_url docs say `Content-Type: video/mp4`).
 *   - Download URLs (api image URLs, vidgen.x.ai) are assumed fetchable without the API key.
 */

import type { Artifact } from "@flowgraph/spec";
import type {
  JobHandle,
  JobStatus,
  MediaCallContext,
  MediaInput,
  MediaOutput,
  MediaProvider,
  MediaRequest,
  MediaVendor,
  MediaVendorOptions,
} from "@flowgraph/core";
import { base64ToBytes, joinUrl, requestJson, resolveApiKey } from "../http.js";

const VENDOR = "xai";
const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_KEY_ENV = "XAI_API_KEY";
const FALLBACK_KEY_ENV = "GROK_API_KEY";
const DEFAULT_IMAGE_MODEL = "grok-imagine-image-2.0";
const DEFAULT_VIDEO_MODEL = "grok-imagine-video-1.5";
const MAX_IMAGES_PER_REQUEST = 10;
const MAX_EDIT_SOURCES = 5;
const DEFAULT_VIDEO_SECONDS = 8;
const TICKS_PER_USD = 1e10;

const IMAGE_RESOLUTIONS = new Set(["1k", "1.5k", "2k"]);
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);
const IMAGE_QUALITIES = new Set(["low", "medium", "auto"]);

/** USD per second of video (https://docs.x.ai/developers/models.md "Imagine Pricing"). */
const VIDEO_USD_PER_SECOND: Record<string, number> = {
  "grok-imagine-video-1.5": 0.08,
  "grok-imagine-video-1.5-lite": 0.02,
  "grok-imagine-video": 0.05,
};

interface ImageItem {
  url?: string | null;
  b64_json?: string | null;
  mime_type?: string | null;
}

interface ImageResponse {
  data?: ImageItem[] | null;
  request_id?: string;
}

interface VideoPollResponse {
  status?: string;
  progress?: number | null;
  error?: { code?: string; message?: string } | null;
  video?: { url?: string | null; duration?: number | null; respect_moderation?: boolean | null } | null;
  usage?: { cost_in_usd_ticks?: number | null } | null;
}

function isHttpUrl(s: string | undefined): s is string {
  return !!s && /^https?:\/\//i.test(s);
}

/** Public URL inputs pass straight through; local/other inputs become data URIs (both accepted by xAI). */
async function inputUrl(input: MediaInput): Promise<string> {
  return isHttpUrl(input.url) ? input.url : input.dataUri();
}

function isImage2(model: string): boolean {
  return model.startsWith("grok-imagine-image-2");
}

function pickResolution(req: MediaRequest, allowed: Set<string>, kind: string): string | undefined {
  const explicit = req.resolution?.trim().toLowerCase();
  if (explicit) return explicit;
  const size = req.size?.trim().toLowerCase();
  if (!size) return undefined;
  if (allowed.has(size)) return size;
  throw new Error(
    `xai: ${kind} "size" ("${req.size}") is not supported; xAI takes a resolution (${[...allowed].join(", ")}) ` +
      `and an aspectRatio instead. Use those fields.`,
  );
}

export const xaiVendor: MediaVendor = {
  vendor: VENDOR,
  modalities: ["image", "video"],
  defaultApiKeyEnv: DEFAULT_KEY_ENV,
  create(opts: MediaVendorOptions): MediaProvider {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const keyEnv = opts.apiKeyEnv ?? DEFAULT_KEY_ENV;
    // Same fallback rule as the langchain factory: GROK_API_KEY only backs the default env var.
    const keyNames = [keyEnv, keyEnv === DEFAULT_KEY_ENV ? FALLBACK_KEY_ENV : undefined];
    const responseFormat =
      opts.options?.["responseFormat"] === "b64_json" ? ("b64_json" as const) : ("url" as const);

    const modelFor = (req: MediaRequest): string =>
      req.model ?? opts.model ?? (req.modality === "video" ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL);

    const authHeaders = async (ctx: MediaCallContext): Promise<Record<string, string>> => ({
      Authorization: `Bearer ${await resolveApiKey(VENDOR, ctx, keyNames)}`,
    });

    async function startImage(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
      const model = modelFor(req);
      if (!req.prompt) throw new Error("xai: image generation needs a prompt");
      if (req.count < 1 || req.count > MAX_IMAGES_PER_REQUEST) {
        throw new Error(`xai: n must be 1-${MAX_IMAGES_PER_REQUEST} per request (got ${req.count})`);
      }
      if (req.negativePrompt) {
        throw new Error("xai: negativePrompt is not supported by the xAI image API; describe exclusions in the prompt");
      }
      if (req.seed !== undefined) ctx.logger.warn("xai: seed is not supported by the xAI image API and was ignored");

      const body: Record<string, unknown> = { model, prompt: req.prompt };
      if (req.count > 1) body["n"] = req.count;
      if (req.aspectRatio) body["aspect_ratio"] = req.aspectRatio;
      const resolution = pickResolution(req, IMAGE_RESOLUTIONS, "image");
      if (resolution) body["resolution"] = resolution;
      if (req.quality) {
        const q = req.quality.toLowerCase();
        if (!IMAGE_QUALITIES.has(q)) {
          throw new Error(`xai: image quality must be one of low, medium, auto (got "${req.quality}")`);
        }
        if (!isImage2(model)) throw new Error(`xai: "quality" is only supported by grok-imagine-image-2.0, not ${model}`);
        body["quality"] = q;
      }
      body["response_format"] = responseFormat;

      let endpoint = "images/generations";
      if (req.inputs.length > 0) {
        endpoint = "images/edits";
        if (req.inputs.length > MAX_EDIT_SOURCES) {
          throw new Error(`xai: image editing accepts at most ${MAX_EDIT_SOURCES} source images (got ${req.inputs.length})`);
        }
        if (req.inputs.length > 1 && !isImage2(model)) {
          throw new Error(`xai: multi-image editing needs grok-imagine-image-2.0, not ${model}`);
        }
        const refs = await Promise.all(
          req.inputs.map(async (i) => ({ url: await inputUrl(i), type: "image_url" })),
        );
        if (refs.length === 1) body["image"] = refs[0];
        else body["images"] = refs;
      }

      Object.assign(body, req.params);

      const res = await requestJson<ImageResponse>(ctx, joinUrl(baseUrl, endpoint), {
        vendor: VENDOR,
        method: "POST",
        headers: await authHeaders(ctx),
        body,
      });
      if (!res.data) {
        throw new Error(
          res.request_id
            ? "xai: deferred image requests are not supported by this adapter (remove `deferred` from params)"
            : "xai: image response had no `data`",
        );
      }

      const done: Artifact[] = [];
      for (const item of res.data) {
        let out: MediaOutput | undefined;
        if (item.b64_json) {
          out = { bytes: base64ToBytes(item.b64_json), mimeType: item.mime_type ?? "image/jpeg" };
        } else if (item.url) {
          out = item.mime_type ? { url: item.url, mimeType: item.mime_type } : { url: item.url };
        }
        if (out) done.push(await ctx.saveOutput(out));
      }
      if (done.length === 0) {
        throw new Error("xai: the response contained no images (the result may have been filtered by moderation)");
      }
      return { id: res.request_id ?? `xai-image-${Date.now()}`, done };
    }

    async function startVideo(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
      const model = modelFor(req);
      if (req.count > 1) throw new Error("xai: one video per job (count must be 1)");
      const pinned = ["image", "reference_images", "last_frame", "keyframes"].some((k) => k in req.params);
      if (!req.prompt && req.inputs.length === 0 && !pinned) {
        throw new Error("xai: text-to-video needs a prompt");
      }
      if (req.negativePrompt) {
        throw new Error("xai: negativePrompt is not supported by the xAI video API; describe exclusions in the prompt");
      }
      if (req.seed !== undefined) ctx.logger.warn("xai: seed is not supported by the xAI video API and was ignored");

      const body: Record<string, unknown> = { model };
      if (req.prompt) body["prompt"] = req.prompt;
      if (req.duration !== undefined) {
        if (!Number.isFinite(req.duration) || req.duration < 1 || req.duration > 15) {
          throw new Error(`xai: video duration must be 1-15 seconds (got ${req.duration})`);
        }
        body["duration"] = Math.round(req.duration);
      }
      if (req.aspectRatio) body["aspect_ratio"] = req.aspectRatio;
      const resolution = pickResolution(req, VIDEO_RESOLUTIONS, "video");
      if (resolution) body["resolution"] = resolution;

      if (req.inputs.length === 1) {
        // One input = image-to-video: the image is the first frame.
        body["image"] = { url: await inputUrl(req.inputs[0]!) };
      } else if (req.inputs.length > 1) {
        // Several inputs = reference-to-video (style/content references, not the first frame).
        const max = model === "grok-imagine-video" ? 7 : 14;
        if (model.includes("lite")) throw new Error(`xai: ${model} does not support reference images`);
        if (req.inputs.length > max) {
          throw new Error(`xai: ${model} accepts at most ${max} reference images (got ${req.inputs.length})`);
        }
        body["reference_images"] = await Promise.all(req.inputs.map(async (i) => ({ url: await inputUrl(i) })));
      }

      Object.assign(body, req.params);

      const res = await requestJson<{ request_id?: string }>(ctx, joinUrl(baseUrl, "videos/generations"), {
        vendor: VENDOR,
        method: "POST",
        headers: await authHeaders(ctx),
        body,
      });
      if (!res.request_id) throw new Error("xai: video response had no request_id");
      return { id: res.request_id, model };
    }

    async function getVideo(handle: JobHandle, ctx: MediaCallContext): Promise<VideoPollResponse> {
      return requestJson<VideoPollResponse>(ctx, joinUrl(baseUrl, `videos/${encodeURIComponent(handle.id)}`), {
        vendor: VENDOR,
        method: "GET",
        headers: await authHeaders(ctx),
      });
    }

    return {
      name: opts.name,
      vendor: VENDOR,
      modalities: ["image", "video"],
      models: {
        image: ["grok-imagine-image-2.0", "grok-imagine-image"],
        video: ["grok-imagine-video-1.5", "grok-imagine-video-1.5-lite", "grok-imagine-video"],
      },
      maxPerJob: { image: MAX_IMAGES_PER_REQUEST, video: 1 },
      // The docs poll every 5 s; video takes up to several minutes.
      pollIntervalMs: 5000,

      async start(req, ctx) {
        if (req.modality === "image") return startImage(req, ctx);
        if (req.modality === "video") return startVideo(req, ctx);
        throw new Error(`xai: unsupported modality "${req.modality}" (image, video)`);
      },

      async poll(handle, ctx): Promise<JobStatus> {
        const res = await getVideo(handle, ctx);
        const costUSD =
          typeof res.usage?.cost_in_usd_ticks === "number" ? res.usage.cost_in_usd_ticks / TICKS_PER_USD : undefined;
        const cost = costUSD !== undefined ? { costUSD } : {};
        switch (res.status) {
          case "done":
            if (!res.video?.url || res.video.respect_moderation === false) {
              return { state: "failed", error: "the video was withheld by content moderation (no URL returned)", ...cost };
            }
            return { state: "done", progress: 100, ...cost };
          case "failed": {
            const code = res.error?.code;
            const msg = res.error?.message;
            return {
              state: "failed",
              error: [code, msg].filter(Boolean).join(": ") || "video generation failed",
            };
          }
          case "expired":
            return { state: "failed", error: "the request expired before it completed" };
          default: {
            const p = typeof res.progress === "number" ? res.progress : undefined;
            return {
              state: p !== undefined && p > 0 ? "running" : "queued",
              ...(p !== undefined ? { progress: p } : {}),
            };
          }
        }
      },

      async fetch(handle, ctx) {
        const res = await getVideo(handle, ctx);
        if (res.status !== "done" || !res.video?.url) {
          throw new Error(`xai: video ${handle.id} is not ready (status ${res.status ?? "unknown"})`);
        }
        const seconds = res.video.duration;
        return [
          await ctx.saveOutput({
            url: res.video.url,
            mimeType: "video/mp4",
            ...(typeof seconds === "number" ? { meta: { durationMs: seconds * 1000 } } : {}),
          }),
        ];
      },

      estimateCostUSD(req) {
        const model = modelFor(req);
        if (req.modality === "video") {
          const rate = VIDEO_USD_PER_SECOND[model];
          return rate === undefined ? undefined : rate * (req.duration ?? DEFAULT_VIDEO_SECONDS);
        }
        if (req.modality !== "image") return undefined;
        const quality = req.quality?.toLowerCase();
        const res = (req.resolution ?? req.size)?.toLowerCase();
        if (model === "grok-imagine-image") {
          // $0.02/image (models page). The input-image charge for edits is not documented for 1.0.
          return req.inputs.length === 0 ? 0.02 * req.count : undefined;
        }
        if (model !== "grok-imagine-image-2.0") return undefined;
        // Low quality is the only tier with documented prices (migration page). Generation `auto` serves low;
        // edit `auto` serves medium, whose price is not documented.
        const isEdit = req.inputs.length > 0;
        if (quality === "medium" || (isEdit && quality !== "low")) return undefined;
        const perImage = res === undefined || res === "1k" ? 0.04 : res === "2k" ? 0.06 : undefined;
        if (perImage === undefined) return undefined;
        // Input images are billed once per request ($0.01 each), outputs per image.
        return perImage * req.count + (isEdit ? 0.01 * req.inputs.length : 0);
      },
    };
  },
};
