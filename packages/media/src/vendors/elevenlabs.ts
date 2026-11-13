/**
 * ElevenLabs audio adapter: speech (text-to-speech), sound effects, music.
 *
 * Docs read on 2026-11-05 (Accept: text/markdown renditions of the pages):
 *   TTS         https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 *   SFX         https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
 *   Music       https://elevenlabs.io/docs/api-reference/music/compose
 *               https://elevenlabs.io/docs/eleven-api/guides/cookbooks/music
 *               https://elevenlabs.io/docs/overview/capabilities/music
 *   Voices      https://elevenlabs.io/docs/api-reference/voices/search
 *   Models      https://elevenlabs.io/docs/overview/models  (models, char limits, deprecations, concurrency)
 *   Errors      https://elevenlabs.io/docs/eleven-api/resources/errors
 *   Auth        https://elevenlabs.io/docs/api-reference/authentication
 *   Prices      https://elevenlabs.io/pricing/api  (marketing page, HTML; not the docs)
 *
 * Verified from docs (NOT from live calls: no API key was available, nothing here
 * has been run against the real API):
 *   - Auth is the `xi-api-key` header; docs/quickstarts name the env var ELEVENLABS_API_KEY.
 *   - All three endpoints are SYNCHRONOUS and return the audio bytes in the 200 body:
 *       POST /v1/text-to-speech/{voice_id}?output_format=...   body {text, model_id, language_code,
 *            voice_settings, seed (0..4294967295), ...}
 *       POST /v1/sound-generation?output_format=...            body {text, duration_seconds (0.5..30 per the
 *            API reference; the capability page says 0.1..30), prompt_influence (0..1), loop, model_id}
 *       POST /v1/music?output_format=...                        body {prompt | composition_plan,
 *            music_length_ms (3000..600000), model_id, force_instrumental, seed, ...}
 *     (There is also /v1/music/detailed, multipart with JSON metadata; not used.) No job id, no polling.
 *   - Voice name lookup: GET /v2/voices?search=...&page_size=100 -> {voices:[{voice_id,name,...}]}.
 *   - output_format values (TTS/SFX): mp3_{22050_32,24000_48,44100_32|64|96|128|192}, opus_48000_{32..192},
 *     pcm_*, wav_{8000..48000}, ulaw_8000, alaw_8000. Music has no wav_*; it adds mp3_48000_{128,192,240,320}
 *     and "auto" (default; mp3_44100_128 for v1, mp3_48000_192 for v2). mp3 192kbps needs Creator+;
 *     PCM/WAV 44.1kHz needs Pro+ (TTS/SFX pages).
 *   - Models: TTS eleven_v4 (recommended; 10,000 chars), eleven_v4_turbo, eleven_v3 (5,000),
 *     eleven_multilingual_v2 (10,000; the API default), eleven_flash_v2_5 (40,000), eleven_flash_v2 (30,000).
 *     SFX eleven_text_to_sound_v3 (v2 is the API default but deprecated, removal 2027-03-01).
 *     Music music_v2_5 (newest), music_v2; music_v1 is the API default but deprecated, removal 2027-01-31.
 *   - Music API is for paid plans only (music quickstart); music concurrency is 0 on Free, 2 on
 *     Starter/Creator/Pro, 5 on Scale/Business. Music is "cleared for nearly all commercial uses", see
 *     https://elevenlabs.io/music-terms (plan-dependent; the pricing page says "Commercial use licensing on Starter+").
 *   - Errors are `{detail: {type, code, message, status, request_id, param}}`; 422 is `{detail: [{loc,msg,type}]}`;
 *     429 code is rate_limit_exceeded or concurrent_limit_exceeded; music copyright hits are 400-class
 *     `bad_prompt` with detail.data.prompt_suggestion.
 *   - `language_code` is ignored by (documented as unsupported for) eleven_multilingual_v2, so it is not sent there.
 *   - Music `seed` cannot be combined with `prompt`; `force_instrumental` and `music_length_ms` only work with
 *     `prompt` (all per the compose reference), so a params.composition_plan drops prompt/length/instrumental.
 *   - Prices (pricing page, USD): TTS $0.08 per 1K chars (v4, v3, multilingual v2), $0.04 (v4 Turbo, Flash,
 *     v3 Conversational); Music $0.15/min; Sound Effects $0.12/min. Used only for estimateCostUSD.
 *
 * Assumed (not confirmed by docs):
 *   - XI_API_KEY as an alternate env name (older SDK habit); only tried when no apiKeyEnv is configured.
 *   - Music lyrics: there is no lyrics field with a plain prompt, so `text` is appended to the prompt as a
 *     "Lyrics:" block (the best-practices page says you can write your own lyrics in the prompt).
 *   - opus_48000_* is served as an Ogg container, so mimeType "audio/ogg"; pcm_* is raw 16-bit PCM
 *     ("audio/pcm"); wav_* is "audio/wav".
 *   - Voice ids look like 20 alphanumeric characters (e.g. JBFqnCBsd6RMkjVDRZzb); anything else is treated as a name.
 *   - The `song-id` response header on music (docs: "find the song ID in the response headers") is stored in
 *     meta.songId when present.
 *   - Cost estimates are list prices; the pricing FAQ says music and SFX are billed "per generation" while
 *     listing a per-minute price, so SFX/music are only estimated when a duration is requested.
 *   - Request stitching (previous_text/next_text/previous_request_ids) is available through `params`; not wired.
 */

import { randomUUID } from "node:crypto";
import type { MediaCallContext, MediaProvider, MediaRequest, MediaVendor, MediaVendorOptions } from "@flowgraph/core";
import { joinUrl, requestJson, resolveApiKey, VendorHttpError } from "../http.js";

const VENDOR = "elevenlabs";
const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ENV = "ELEVENLABS_API_KEY";
const ALT_ENV = "XI_API_KEY";

type AudioKind = "speech" | "sfx" | "music";

const DEFAULT_MODELS: Record<AudioKind, string> = {
  speech: "eleven_v4",
  sfx: "eleven_text_to_sound_v3",
  music: "music_v2_5",
};

/** Max characters per TTS request, from the models page. Models absent here are not checked client-side. */
const SPEECH_CHAR_LIMITS: Record<string, number> = {
  eleven_v4: 10_000,
  eleven_v3: 5_000,
  eleven_flash_v2_5: 40_000,
  eleven_flash_v2: 30_000,
  eleven_multilingual_v2: 10_000,
  eleven_multilingual_v1: 10_000,
};

/** USD per 1,000 characters, from https://elevenlabs.io/pricing/api. */
const SPEECH_USD_PER_1K: Record<string, number> = {
  eleven_v4: 0.08,
  eleven_v3: 0.08,
  eleven_multilingual_v2: 0.08,
  eleven_v4_turbo: 0.04,
  eleven_v3_conversational: 0.04,
  eleven_flash_v2_5: 0.04,
  eleven_flash_v2: 0.04,
  eleven_turbo_v2_5: 0.04,
  eleven_turbo_v2: 0.04,
};
const SFX_USD_PER_MIN = 0.12;
const MUSIC_USD_PER_MIN = 0.15;

const MUSIC_MIN_MS = 3_000;
const MUSIC_MAX_MS = 600_000;

/** Keys of `req.params` that belong in the query string, not the JSON body. */
const QUERY_PARAMS = ["output_format", "enable_logging"] as const;

const VOICE_ID_RE = /^[A-Za-z0-9]{20}$/;

function modelKind(model: string): AudioKind {
  if (model.startsWith("music_")) return "music";
  if (model.startsWith("eleven_text_to_sound")) return "sfx";
  return "speech";
}

function clip(text: string, max = 500): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Turn an ElevenLabs error body into one readable line (never contains the key). */
function describeError(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return clip(text);
  }
  const detail = (parsed as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return clip(detail);
  if (Array.isArray(detail)) {
    const parts = detail.map((d: { loc?: unknown[]; msg?: string }) =>
      `${Array.isArray(d.loc) ? d.loc.join(".") : "?"}: ${d.msg ?? "invalid"}`,
    );
    return clip(`validation error: ${parts.join("; ")}`);
  }
  if (detail && typeof detail === "object") {
    const d = detail as {
      code?: string;
      status?: string;
      message?: string;
      param?: string;
      request_id?: string;
      data?: { prompt_suggestion?: string };
    };
    const label = d.code ?? d.status;
    let out = [label, d.message].filter(Boolean).join(": ");
    if (d.param) out += ` (param ${d.param})`;
    if (d.data?.prompt_suggestion) out += ` (suggested prompt: ${d.data.prompt_suggestion})`;
    if (d.request_id) out += ` [request_id ${d.request_id}]`;
    return clip(out || text);
  }
  return clip(text);
}

function mimeForOutputFormat(outputFormat: string | undefined): string {
  const f = outputFormat ?? "auto";
  if (f.startsWith("mp3_") || f === "auto") return "audio/mpeg";
  if (f.startsWith("wav_")) return "audio/wav";
  if (f.startsWith("opus_")) return "audio/ogg";
  if (f.startsWith("pcm_")) return "audio/pcm";
  if (f.startsWith("ulaw_")) return "audio/basic";
  if (f.startsWith("alaw_")) return "audio/x-alaw-basic";
  return "audio/mpeg";
}

/** Map flowgraph's `format` to an ElevenLabs `output_format` for this kind. */
function formatToOutputFormat(kind: AudioKind, format: string | undefined): string | undefined {
  if (!format) return kind === "music" ? undefined : "mp3_44100_128";
  const f = format.trim().toLowerCase().replace(/^\./, "");
  switch (f) {
    case "mp3":
      return "mp3_44100_128";
    case "opus":
      return "opus_48000_128";
    case "wav":
      if (kind === "music") {
        throw new Error(
          `${VENDOR}: music has no wav output_format (mp3, opus and raw pcm_* only). ` +
            `Use format: mp3, or set params.output_format (e.g. "pcm_44100") for raw PCM.`,
        );
      }
      return "wav_44100";
    case "ogg":
    case "flac":
      throw new Error(
        `${VENDOR}: format "${f}" is not supported (mp3, wav and opus are; ` +
          `or set params.output_format to a documented value such as "pcm_24000").`,
      );
    default:
      throw new Error(`${VENDOR}: unknown audio format "${format}" (use mp3, wav or opus).`);
  }
}

function normalizeLanguage(lang: string): string {
  return (lang.trim().split(/[-_]/)[0] ?? lang).toLowerCase();
}

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

interface Resolved {
  kind: AudioKind;
  model: string;
}

class Elevenlabs {
  constructor(private readonly opts: MediaVendorOptions) {}

  private get baseUrl(): string {
    return this.opts.baseUrl?.trim() || DEFAULT_BASE_URL;
  }

  private optionString(key: string): string | undefined {
    const v = this.opts.options?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  }

  private kindOf(req: MediaRequest): AudioKind {
    const kind = req.audioKind;
    if (kind !== "speech" && kind !== "sfx" && kind !== "music") {
      throw new Error(`${VENDOR}: audio kind must be speech, sfx or music (got ${String(kind)})`);
    }
    return kind;
  }

  /** request model > options.<kind>Model > provider model (when it fits the kind) > default. */
  resolve(req: MediaRequest): Resolved {
    const kind = this.kindOf(req);
    if (req.model && modelKind(req.model) !== kind) {
      throw new Error(`${VENDOR}: model "${req.model}" is a ${modelKind(req.model)} model, but the node asks for ${kind}`);
    }
    const perKind = this.optionString(`${kind}Model`);
    const provider = this.opts.model && modelKind(this.opts.model) === kind ? this.opts.model : undefined;
    return { kind, model: req.model ?? perKind ?? provider ?? DEFAULT_MODELS[kind] };
  }

  private async key(ctx: MediaCallContext): Promise<string> {
    const names = this.opts.apiKeyEnv ? [this.opts.apiKeyEnv] : [DEFAULT_ENV, ALT_ENV];
    return resolveApiKey(VENDOR, ctx, names);
  }

  private headers(key: string): Record<string, string> {
    return { "xi-api-key": key, "Content-Type": "application/json" };
  }

  /** Split req.params into query-string values and JSON-body overrides. */
  private splitParams(params: Record<string, unknown>): { query: Record<string, string>; body: Record<string, unknown> } {
    const body = { ...params };
    const query: Record<string, string> = {};
    for (const k of QUERY_PARAMS) {
      if (k in body) {
        const v = body[k];
        delete body[k];
        if (v !== undefined && v !== null) query[k] = String(v);
      }
    }
    return { query, body };
  }

  /** POST JSON, expect binary audio. */
  private async postAudio(
    ctx: MediaCallContext,
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown>,
    key: string,
  ): Promise<{ bytes: Uint8Array; headers: Headers }> {
    const qs = new URLSearchParams(query).toString();
    const url = joinUrl(this.baseUrl, path) + (qs ? `?${qs}` : "");
    const res = await ctx.fetch(url, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify(body),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!res.ok) {
      throw new VendorHttpError(VENDOR, res.status, describeError(await res.text()));
    }
    const type = res.headers.get("content-type") ?? "";
    if (/json|text\//i.test(type)) {
      throw new Error(`${VENDOR}: expected audio from ${path} but got ${type}: ${clip(await res.text(), 120)}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error(`${VENDOR}: ${path} returned an empty audio body`);
    return { bytes, headers: res.headers };
  }

  /** Voice id as-is when it looks like one, otherwise a name lookup through GET /v2/voices. */
  async resolveVoice(voice: string, ctx: MediaCallContext, key: string): Promise<string> {
    const v = voice.trim();
    if (VOICE_ID_RE.test(v)) return v;
    const qs = new URLSearchParams({ search: v, page_size: "100" }).toString();
    const res = await requestJson<{ voices?: { voice_id: string; name?: string }[] }>(
      ctx,
      `${joinUrl(this.baseUrl, "/v2/voices")}?${qs}`,
      { vendor: VENDOR, method: "GET", headers: { "xi-api-key": key } },
    );
    const voices = res.voices ?? [];
    const want = v.toLowerCase();
    let hits = voices.filter((x) => (x.name ?? "").trim().toLowerCase() === want);
    if (hits.length === 0) {
      // Library names are often "Rachel - Calm and warm": accept the part before " - ".
      hits = voices.filter((x) => (x.name ?? "").split(/\s+[-–—]\s+/)[0]?.trim().toLowerCase() === want);
    }
    if (hits.length === 1) return hits[0]!.voice_id;
    if (hits.length > 1) {
      const list = hits.map((h) => `${h.name} (${h.voice_id})`).join(", ");
      throw new Error(`${VENDOR}: voice name "${v}" is ambiguous: ${list}. Use the voice id instead.`);
    }
    const near = voices
      .slice(0, 5)
      .map((x) => x.name)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `${VENDOR}: no voice named "${v}" found${near ? ` (closest: ${near})` : ""}. ` +
        `Use a voice id from GET /v2/voices or a voice name from your library.`,
    );
  }

  private async save(
    ctx: MediaCallContext,
    audio: { bytes: Uint8Array; headers: Headers },
    mimeType: string,
    durationMs: number | undefined,
  ): Promise<{ id: string; done: Awaited<ReturnType<MediaCallContext["saveOutput"]>>[] }> {
    const songId = audio.headers.get("song-id");
    const meta = {
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(songId ? { songId } : {}),
    };
    const artifact = await ctx.saveOutput({
      bytes: audio.bytes,
      mimeType,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
    return { id: `elevenlabs-${randomUUID()}`, done: [artifact] };
  }

  async start(req: MediaRequest, ctx: MediaCallContext) {
    const { kind, model } = this.resolve(req);
    const key = await this.key(ctx);
    const { query, body: extra } = this.splitParams(req.params ?? {});
    const outputFormat = query.output_format ?? formatToOutputFormat(kind, req.format);
    if (outputFormat) query.output_format = outputFormat;
    const mimeType = mimeForOutputFormat(outputFormat);

    if (kind === "speech") return this.startSpeech(req, ctx, key, model, query, extra, mimeType);
    if (kind === "sfx") return this.startSfx(req, ctx, key, model, query, extra, mimeType);
    return this.startMusic(req, ctx, key, model, query, extra, mimeType);
  }

  private async startSpeech(
    req: MediaRequest,
    ctx: MediaCallContext,
    key: string,
    model: string,
    query: Record<string, string>,
    extra: Record<string, unknown>,
    mimeType: string,
  ) {
    const text = req.text?.trim();
    if (!text) throw new Error(`${VENDOR}: speech requires text`);
    const limit = SPEECH_CHAR_LIMITS[model];
    const chars = [...text].length;
    if (limit && chars > limit) {
      throw new Error(`${VENDOR}: text is ${chars} characters but ${model} accepts at most ${limit} per request; split it.`);
    }
    const voice = req.voice?.trim() || this.optionString("defaultVoice");
    if (!voice) {
      throw new Error(`${VENDOR}: speech requires a voice (voice id or name); set \`voice\` on the node or options.defaultVoice on the provider.`);
    }
    const voiceId = await this.resolveVoice(voice, ctx, key);
    ctx.logger.debug(`elevenlabs speech: model=${model} voice=${voiceId} chars=${chars}`);

    const body: Record<string, unknown> = {
      text,
      model_id: model,
      ...(req.language && model !== "eleven_multilingual_v2" ? { language_code: normalizeLanguage(req.language) } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...extra,
    };
    const audio = await this.postAudio(ctx, `/v1/text-to-speech/${encodeURIComponent(voiceId)}`, query, body, key);
    return this.save(ctx, audio, mimeType, undefined);
  }

  private async startSfx(
    req: MediaRequest,
    ctx: MediaCallContext,
    key: string,
    model: string,
    query: Record<string, string>,
    extra: Record<string, unknown>,
    mimeType: string,
  ) {
    const text = (req.prompt ?? req.text)?.trim();
    if (!text) throw new Error(`${VENDOR}: sound effects require a prompt`);
    ctx.logger.debug(`elevenlabs sfx: model=${model} duration=${req.duration ?? "auto"}`);
    const body: Record<string, unknown> = {
      text,
      model_id: model,
      ...(req.duration !== undefined ? { duration_seconds: req.duration } : {}),
      ...extra,
    };
    const audio = await this.postAudio(ctx, "/v1/sound-generation", query, body, key);
    return this.save(ctx, audio, mimeType, req.duration !== undefined ? secondsToMs(req.duration) : undefined);
  }

  private async startMusic(
    req: MediaRequest,
    ctx: MediaCallContext,
    key: string,
    model: string,
    query: Record<string, string>,
    extra: Record<string, unknown>,
    mimeType: string,
  ) {
    const usesPlan = extra.composition_plan !== undefined && extra.composition_plan !== null;
    const lengthMs = req.duration !== undefined ? secondsToMs(req.duration) : undefined;
    if (lengthMs !== undefined && (lengthMs < MUSIC_MIN_MS || lengthMs > MUSIC_MAX_MS)) {
      throw new Error(`${VENDOR}: music duration must be between ${MUSIC_MIN_MS / 1000}s and ${MUSIC_MAX_MS / 1000}s (got ${req.duration}s)`);
    }

    const body: Record<string, unknown> = { model_id: model };
    if (!usesPlan) {
      const prompt = req.prompt?.trim();
      const lyrics = req.text?.trim();
      if (!prompt && !lyrics) throw new Error(`${VENDOR}: music requires a prompt or lyrics`);
      if (req.instrumental && lyrics) {
        throw new Error(`${VENDOR}: music cannot be both instrumental and have lyrics (drop \`text\` or \`instrumental\`)`);
      }
      body.prompt = lyrics
        ? `${prompt ?? "A song with the following lyrics."}\n\nLyrics:\n${lyrics}`
        : prompt;
      if (lengthMs !== undefined) body.music_length_ms = lengthMs;
      if (req.instrumental) body.force_instrumental = true;
    }
    // `seed` cannot be combined with `prompt` (compose reference), so it is only forwarded with a plan.
    if (usesPlan && req.seed !== undefined) body.seed = req.seed;
    ctx.logger.debug(`elevenlabs music: model=${model} lengthMs=${lengthMs ?? "auto"} plan=${usesPlan}`);
    Object.assign(body, extra);

    const audio = await this.postAudio(ctx, "/v1/music", query, body, key);
    return this.save(ctx, audio, mimeType, lengthMs);
  }

  estimateCostUSD(req: MediaRequest): number | undefined {
    let r: Resolved;
    try {
      r = this.resolve(req);
    } catch {
      return undefined;
    }
    if (r.kind === "speech") {
      const rate = SPEECH_USD_PER_1K[r.model];
      const chars = [...(req.text ?? "")].length;
      return rate !== undefined && chars > 0 ? (chars / 1000) * rate : undefined;
    }
    if (req.duration === undefined) return undefined;
    return (req.duration / 60) * (r.kind === "sfx" ? SFX_USD_PER_MIN : MUSIC_USD_PER_MIN);
  }
}

export const elevenlabsVendor: MediaVendor = {
  vendor: VENDOR,
  modalities: ["audio"],
  defaultApiKeyEnv: DEFAULT_ENV,
  create(opts: MediaVendorOptions): MediaProvider {
    const el = new Elevenlabs(opts);
    return {
      name: opts.name,
      vendor: VENDOR,
      modalities: ["audio"],
      audioKinds: ["speech", "sfx", "music"],
      models: {
        audio: [
          "eleven_v4",
          "eleven_v4_turbo",
          "eleven_v3",
          "eleven_multilingual_v2",
          "eleven_flash_v2_5",
          "eleven_text_to_sound_v3",
          "music_v2_5",
          "music_v2",
        ],
      },
      maxPerJob: { audio: 1 },
      start: (req, ctx) => el.start(req, ctx),
      estimateCostUSD: (req) => el.estimateCostUSD(req),
    };
  },
};
