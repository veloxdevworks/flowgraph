/**
 * OpenAI image generation / editing ("ChatGPT image gen", the GPT Image model family).
 *
 * Written 2026-11-05 from the official docs (markdown variants of):
 *   - https://developers.openai.com/api/reference/resources/images/methods/generate
 *   - https://developers.openai.com/api/reference/resources/images/methods/edit
 *   - https://developers.openai.com/api/docs/guides/image-generation
 *   - https://developers.openai.com/api/docs/pricing                      (image generation section)
 *   - https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst (and -flare, gpt-image-2)
 *   - https://developers.openai.com/api/docs/deprecations                 (GPT Image model deprecations)
 *   - https://developers.openai.com/api/reference/overview                (auth + org/project headers)
 *   - https://developers.openai.com/api/docs/guides/error-codes
 *   - https://developers.openai.com/api/docs/guides/rate-limits
 *
 * Shape of the integration
 *   Synchronous. `start()` POSTs `{base}/images/generations` (no inputs) or `{base}/images/edits`
 *   (inputs present), decodes `data[].b64_json`, saves each image through `ctx.saveOutput` and
 *   returns `{ id, done }`. No poll/fetch. Streaming (`stream: true`) is NOT supported.
 *
 * Verified from docs (read, never exercised live: no API key was available)
 *   - Auth: `Authorization: Bearer <key>`; optional `OpenAI-Organization` and `OpenAI-Project` headers.
 *   - Generations: JSON body {model, prompt (<=32000 chars), n 1..10, size, quality, background,
 *     moderation, output_format png|jpeg|webp (gif/svg on 2.6 preview), output_compression 0..100,
 *     safety_identifier, ...}. GPT image models always return base64 (`data[].b64_json`); `response_format`,
 *     `style`, `revised_prompt` and `url` are not used by them.
 *   - Edits: multipart (`image[]` repeated, `mask`, `prompt`, `model`, ...) OR JSON (`images: [{image_url|file_id}]`,
 *     `mask: {image_url|file_id}`, `markup`). Up to 16 input images for GPT image models, n 1..10.
 *     `input_fidelity` high|low is accepted on gpt-image-1.5 only (omit it for gpt-image-2 and later).
 *   - Models: gpt-image-2.5-sunburst (editing precision) and gpt-image-2.5-flare (fast) are the recommended
 *     models; the edits endpoint documents `gpt-image-2.5-sunburst` as its default. gpt-image-2, gpt-image-2.6-sunburst
 *     and gpt-image-2.6-flare also exist. `gpt-image-1` was shut down 2026-10-23; `gpt-image-1-mini`, `gpt-image-1.5`
 *     and `chatgpt-image-latest` shut down 2026-12-01.
 *   - Sizes: `auto`, `1024x1024`, `1536x1024`, `1024x1536`; gpt-image-2 and later also accept any WIDTHxHEIGHT with
 *     both edges multiples of 16, max edge 3840, aspect ratio within 1:3..3:1, 655,360..8,294,400 total pixels
 *     (above 2560x1440 is experimental).
 *   - Quality: low|medium|high|auto; gpt-image-2.5 and later also xhigh|max.
 *   - Response: {created, data[{b64_json}], usage{input_tokens, input_tokens_details{text_tokens,image_tokens},
 *     output_tokens, output_tokens_details?, total_tokens}, output_format?, quality?, size?, background?}.
 *   - Pricing is token based (per 1M tokens, Standard): gpt-image-2 / 2.5 / 2.6: text in $5, image in $8,
 *     image out $30; gpt-image-1.5 / chatgpt-image-latest: text in $5, image in $8, image out $32;
 *     gpt-image-1-mini: text in $2, image in $2.50, image out $8. Text output is not billed. Cached-input rates do
 *     not apply to direct Images API calls.
 *   - Errors: HTTP 4xx/5xx with {error:{message,type,code,param}}; user-correctable image failures use
 *     type "image_generation_user_error" (e.g. code "moderation_blocked" with optional moderation_details).
 *     429s may carry `Retry-After`. Not retried here.
 *   - Rate limits (per model page, IPM = images per minute): Build 20 IPM / 250K TPM, Launch 150 / 3M, Grow 250 / 8M.
 *   - Org verification may be required before GPT image models can be used.
 *
 * Assumed (not stated explicitly in the docs, or only inferred)
 *   - Single-image multipart edits use the same `image[]` field name as multi-image ones (docs show `image[]` for
 *     every curl example; SDK samples use `image=`).
 *   - Accepted edit input formats are png / jpeg / webp (the docs state this for vision inputs; edits do not list
 *     formats separately). Per-file limit is ~50 MB (documented for mask and markup; assumed for images).
 *   - JSON edit mode (selected here only when `params` carries object values such as `mask`/`markup`) works as the
 *     API reference describes; data URLs are limited to 20,971,520 characters per the schema.
 *   - A response `id` is not documented; we use one if present, else generate a local id.
 *   - Cost: the cost is computed after the call from the vendor-reported `usage` and the rates above, and returned as the job handle's `costUSD` (no up-front estimate is possible), and
 *     only against the official API host; it is undefined for unknown models, a custom `baseUrl`, or journal resumes.
 *   - `aspectRatio` -> size conversion for arbitrary ratios relies on the gpt-image-2 "any resolution" rule.
 *
 * Provider options (`providers.<name>.options`): `organization`, `project` (sent as OpenAI-Organization /
 * OpenAI-Project), `params` (default body fields merged under per-request `params`).
 */

import { randomUUID } from "node:crypto";
import type { JobHandle, MediaCallContext, MediaOutput, MediaProvider, MediaRequest, MediaVendor, MediaVendorOptions } from "@flowgraph/core";
import { VendorHttpError, base64ToBytes, joinUrl, requestJson, resolveApiKey } from "../http.js";

const VENDOR = "openai";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-image-2.5-sunburst";
const MODELS = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2",
] as const;

/** `n` is 1..10 on both endpoints. */
const MAX_PER_JOB = 10;
/** Edits accept up to 16 input images for GPT image models. */
const MAX_EDIT_INPUTS = 16;
/** Schema limit on a JSON `image_url` value (data URLs included). */
const MAX_IMAGE_URL_CHARS = 20_971_520;

const OUTPUT_MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

const INPUT_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

interface Rates {
  textIn: number;
  imageIn: number;
  imageOut: number;
}
/** USD per 1M tokens, Standard processing (pricing page, "Image generation models"). */
function ratesFor(model: string): Rates | undefined {
  if (/^gpt-image-2(\.\d+)?(-|$)/.test(model)) return { textIn: 5, imageIn: 8, imageOut: 30 };
  if (/^gpt-image-1\.5(-|$)/.test(model) || model === "chatgpt-image-latest") return { textIn: 5, imageIn: 8, imageOut: 32 };
  if (/^gpt-image-1-mini(-|$)/.test(model)) return { textIn: 2, imageIn: 2.5, imageOut: 8 };
  return undefined;
}

/** GPT image models before gpt-image-2 only take auto and the three standard sizes. */
function supportsArbitrarySizes(model: string): boolean {
  return /^gpt-image-2(\.\d+)?(-|$)/.test(model);
}

interface Usage {
  input_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { text_tokens?: number; image_tokens?: number };
  total_tokens?: number;
}

interface ImagesResponse {
  id?: string;
  created?: number;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  output_format?: string;
  quality?: string;
  size?: string;
  background?: string;
  usage?: Usage;
}

function costFromUsage(model: string, usage: Usage | undefined): number | undefined {
  const rates = ratesFor(model);
  const d = usage?.input_tokens_details;
  if (!rates || !usage || !d || usage.output_tokens === undefined) return undefined;
  const outImageTokens = usage.output_tokens_details?.image_tokens ?? usage.output_tokens;
  const usd =
    ((d.text_tokens ?? 0) * rates.textIn + (d.image_tokens ?? 0) * rates.imageIn + outImageTokens * rates.imageOut) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** Normalize "1024X1024" / "1024*1024" / "1024×1024" to "1024x1024"; "auto" passes through. */
function normalizeSize(size: string): string {
  const s = size.trim().toLowerCase();
  if (s === "auto") return s;
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(s);
  if (!m) throw new Error(`${VENDOR}: unsupported size "${size}". Use "auto" or WIDTHxHEIGHT (e.g. 1536x1024).`);
  return `${m[1]}x${m[2]}`;
}

function parseRatio(aspectRatio: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)$/.exec(aspectRatio.trim());
  const w = m ? Number(m[1]) : NaN;
  const h = m ? Number(m[2]) : NaN;
  if (!(w > 0) || !(h > 0)) throw new Error(`${VENDOR}: unsupported aspectRatio "${aspectRatio}". Use W:H (e.g. 16:9).`);
  const r = w / h;
  if (r > 3 || r < 1 / 3) throw new Error(`${VENDOR}: aspectRatio "${aspectRatio}" is outside the supported range 1:3 to 3:1.`);
  return r;
}

function sizeFromAspectRatio(aspectRatio: string, model: string, ctx: MediaCallContext): string {
  const r = parseRatio(aspectRatio);
  if (supportsArbitrarySizes(model)) {
    if (Math.abs(r - 1) < 1e-9) return "1024x1024";
    const long = 1536;
    const short = Math.max(16, Math.round(long / Math.max(r, 1 / r) / 16) * 16);
    return r > 1 ? `${long}x${short}` : `${short}x${long}`;
  }
  const snapped = r >= 1.25 ? "1536x1024" : r <= 0.8 ? "1024x1536" : "1024x1024";
  if (![1, 1.5, 1 / 1.5].some((x) => Math.abs(r - x) < 0.01)) {
    ctx.logger.warn(`${VENDOR}: model ${model} only supports 1024x1024, 1536x1024 and 1024x1536; aspectRatio ${aspectRatio} snapped to ${snapped}`);
  }
  return snapped;
}

function sniffImageMime(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  return undefined;
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Redact the key from anything that might echo it, and condense OpenAI's error JSON. */
function describeHttpError(err: VendorHttpError, apiKey: string): VendorHttpError {
  let text = err.body;
  try {
    const parsed = JSON.parse(err.body) as { error?: { message?: string; type?: string; code?: string; param?: string; moderation_details?: unknown } };
    const e = parsed.error;
    if (e && (e.message || e.code || e.type)) {
      const tag = [e.type, e.code].filter(Boolean).join("/");
      text = `${tag ? `${tag}: ` : ""}${e.message ?? ""}`.trim();
      if (e.param) text += ` (param: ${e.param})`;
      if (e.moderation_details) text += ` moderation_details=${JSON.stringify(e.moderation_details)}`;
    }
  } catch {
    // Body was not (complete) JSON: keep the clipped raw text.
  }
  if (apiKey) text = text.split(apiKey).join("***");
  return new VendorHttpError(VENDOR, err.status, text);
}

function openaiProvider(opts: MediaVendorOptions): MediaProvider {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const customBase = opts.baseUrl !== undefined;
  const o = opts.options ?? {};
  const organization = typeof o["organization"] === "string" ? (o["organization"] as string) : undefined;
  const project = typeof o["project"] === "string" ? (o["project"] as string) : undefined;
  const defaultParams =
    o["params"] && typeof o["params"] === "object" && !Array.isArray(o["params"]) ? (o["params"] as Record<string, unknown>) : {};


  async function start(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
    if (req.modality !== "image") throw new Error(`${VENDOR}: only the image modality is supported (got ${req.modality}).`);
    const prompt = req.prompt?.trim();
    if (!prompt) throw new Error(`${VENDOR}: an image prompt is required.`);
    if (req.count < 1 || req.count > MAX_PER_JOB) {
      throw new Error(`${VENDOR}: count must be between 1 and ${MAX_PER_JOB} per job (got ${req.count}).`);
    }
    const editing = req.inputs.length > 0;
    if (req.inputs.length > MAX_EDIT_INPUTS) {
      throw new Error(`${VENDOR}: image edits accept at most ${MAX_EDIT_INPUTS} input images (got ${req.inputs.length}).`);
    }
    if (req.params["stream"] === true) throw new Error(`${VENDOR}: streaming (params.stream) is not supported by this adapter.`);

    const model = req.model ?? opts.model ?? DEFAULT_MODEL;
    if (model === "gpt-image-1") {
      ctx.logger.warn(`${VENDOR}: gpt-image-1 was shut down on 2026-10-23; use gpt-image-2.5-sunburst or gpt-image-2.5-flare.`);
    }
    if (req.negativePrompt) {
      ctx.logger.warn(`${VENDOR}: negativePrompt is not supported by the OpenAI Images API and was ignored; describe exclusions in the prompt.`);
    }
    if (req.seed !== undefined) ctx.logger.debug(`${VENDOR}: seed is not supported by the OpenAI Images API and was ignored.`);

    let size: string | undefined;
    if (req.size) {
      size = normalizeSize(req.size);
      if (req.aspectRatio) ctx.logger.warn(`${VENDOR}: both size and aspectRatio were set; using size ${size}.`);
    } else if (req.aspectRatio) {
      size = sizeFromAspectRatio(req.aspectRatio, model, ctx);
    }
    const quality = req.quality ? ({ hd: "high", standard: "medium" } as Record<string, string>)[req.quality] ?? req.quality : undefined;

    const fields: Record<string, unknown> = {
      model,
      prompt,
      n: req.count,
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
      ...defaultParams,
      ...req.params,
    };

    const apiKey = await resolveApiKey(VENDOR, ctx, [opts.apiKeyEnv, "OPENAI_API_KEY"]);
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (organization) headers["OpenAI-Organization"] = organization;
    if (project) headers["OpenAI-Project"] = project;

    let url: string;
    let body: Record<string, unknown> | FormData;
    if (!editing) {
      url = joinUrl(baseUrl, "images/generations");
      body = fields;
    } else {
      url = joinUrl(baseUrl, "images/edits");
      const images = await Promise.all(
        req.inputs.map(async (input, i) => {
          const bytes = await input.bytes();
          const mime = sniffImageMime(bytes) ?? (input.mimeType === "image/jpg" ? "image/jpeg" : input.mimeType.toLowerCase());
          if (!INPUT_EXT[mime]) {
            throw new Error(`${VENDOR}: input image ${i + 1} (${input.ref}) has unsupported type "${input.mimeType}"; use png, jpeg or webp.`);
          }
          return { bytes, mime, name: `image-${i + 1}.${INPUT_EXT[mime]}`, input };
        }),
      );
      const needsJson = Object.values(fields).some((v) => v !== null && v !== undefined && !isPrimitive(v));
      if (needsJson) {
        // Object-valued params (mask / markup as {image_url|file_id}) can only travel in the JSON form of the edits API.
        const jsonImages = await Promise.all(
          images.map(async ({ input }, i) => {
            const image_url = await input.dataUri();
            if (image_url.length > MAX_IMAGE_URL_CHARS) {
              throw new Error(`${VENDOR}: input image ${i + 1} (${input.ref}) is too large for a JSON edit request (limit ${MAX_IMAGE_URL_CHARS} characters).`);
            }
            return { image_url };
          }),
        );
        body = { ...fields, images: jsonImages, ...(Array.isArray(req.params["images"]) ? { images: req.params["images"] } : {}) };
      } else {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) {
          if (v === null || v === undefined) continue;
          form.append(k, String(v));
        }
        for (const im of images) form.append("image[]", new Blob([new Uint8Array(im.bytes)], { type: im.mime }), im.name);
        body = form;
      }
    }

    ctx.logger.debug(`${VENDOR}: POST ${editing ? "images/edits" : "images/generations"}`, {
      model,
      n: req.count,
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
      inputs: req.inputs.length,
    });

    let res: ImagesResponse;
    try {
      res = await requestJson<ImagesResponse>(ctx, url, { vendor: VENDOR, method: "POST", headers, body });
    } catch (err) {
      throw err instanceof VendorHttpError ? describeHttpError(err, apiKey) : err;
    }

    const items = res.data ?? [];
    if (items.length === 0) throw new Error(`${VENDOR}: the response contained no images.`);

    const requestedFormat = typeof fields["output_format"] === "string" ? (fields["output_format"] as string).toLowerCase() : "png";
    const format = res.output_format && OUTPUT_MIME[res.output_format] ? res.output_format : requestedFormat;
    const mimeType = OUTPUT_MIME[format] ?? "image/png";

    const cost = customBase ? undefined : costFromUsage(model, res.usage);

    const dims = /^(\d+)x(\d+)$/.exec(res.size ?? "");
    const baseMeta = {
      ...(dims ? { width: Number(dims[1]), height: Number(dims[2]) } : {}),
      ...(cost !== undefined ? { costUSD: Math.round((cost / items.length) * 1e6) / 1e6 } : {}),
      openai: {
        endpoint: editing ? "images/edits" : "images/generations",
        model,
        ...(res.usage ? { usage: res.usage } : {}),
        ...(res.quality ? { quality: res.quality } : {}),
        ...(res.size ? { size: res.size } : {}),
        ...(res.background ? { background: res.background } : {}),
        ...(res.created !== undefined ? { created: res.created } : {}),
      },
    };

    const done = [];
    for (const item of items) {
      let out: MediaOutput;
      if (item.b64_json) out = { bytes: base64ToBytes(item.b64_json), mimeType, meta: baseMeta };
      else if (item.url) out = { url: item.url, mimeType, meta: baseMeta };
      else throw new Error(`${VENDOR}: a response image had neither b64_json nor url.`);
      done.push(await ctx.saveOutput(out));
    }

    return { id: res.id ?? `openai-img-${res.created ?? Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`, done, ...(cost !== undefined ? { costUSD: cost } : {}) };
  }

  return {
    name: opts.name,
    vendor: VENDOR,
    modalities: ["image"],
    models: { image: MODELS },
    maxPerJob: { image: MAX_PER_JOB },
    start,
  };
}

export const openaiVendor: MediaVendor = {
  vendor: VENDOR,
  modalities: ["image"],
  defaultApiKeyEnv: "OPENAI_API_KEY",
  create: openaiProvider,
};
