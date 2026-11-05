/**
 * Offline tests for the ElevenLabs adapter. Fixtures follow the official docs examples:
 *   TTS   https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 *         (voice JBFqnCBsd6RMkjVDRZzb, "The first move is what sets everything in motion.")
 *   SFX   https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
 *         ("Spacious braam suitable for high-impact movie trailer moments")
 *   Music https://elevenlabs.io/docs/eleven-api/guides/cookbooks/music (music_v2_5, 10000 ms)
 *   Voices https://elevenlabs.io/docs/api-reference/voices/search
 *   Errors https://elevenlabs.io/docs/eleven-api/resources/errors
 * Nothing here talks to the network or proves the real API behaves this way.
 */

import { describe, expect, it } from "vitest";
import type { MediaCallContext, MediaOutput, MediaRequest } from "@flowgraph/core";
import { VendorHttpError } from "../http.js";
import { elevenlabsVendor } from "./elevenlabs.js";

const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const TTS_TEXT = "The first move is what sets everything in motion.";
const BRAAM = "Spacious braam suitable for high-impact movie trailer moments";
const MUSIC_PROMPT =
  "Create an intense, fast-paced electronic track for a high-adrenaline video game scene. Use driving synth arpeggios, punchy drums, distorted bass, glitch effects, and aggressive rhythmic textures.";

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call) => Response;

function audioResponse(bytes: number[] = [1, 2, 3, 4], type = "audio/mpeg", headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type, ...headers } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeCtx(responder: Responder, secrets: Record<string, string> = { ELEVENLABS_API_KEY: "sk-test-key" }) {
  const calls: Call[] = [];
  const saved: MediaOutput[] = [];
  const ctx: MediaCallContext = {
    secrets: { get: async (name: string) => secrets[name] } as MediaCallContext["secrets"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: (async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url: String(input),
        method: init?.method,
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
    saveOutput: async (out: MediaOutput) => {
      saved.push(out);
      return {
        id: `art-${saved.length}`,
        kind: "audio",
        path: `out/${saved.length}`,
        mimeType: "mimeType" in out && out.mimeType ? out.mimeType : "audio/mpeg",
        sizeBytes: "bytes" in out ? out.bytes.length : 0,
      } as unknown as Awaited<ReturnType<MediaCallContext["saveOutput"]>>;
    },
  };
  return { ctx, calls, saved };
}

function req(over: Partial<MediaRequest>): MediaRequest {
  return { modality: "audio", inputs: [], count: 1, params: {}, ...over };
}

function provider(opts: Partial<Parameters<typeof elevenlabsVendor.create>[0]> = {}) {
  return elevenlabsVendor.create({ name: "eleven", ...opts });
}

describe("elevenlabs vendor metadata", () => {
  it("declares the audio modality, kinds and env var", () => {
    expect(elevenlabsVendor.vendor).toBe("elevenlabs");
    expect(elevenlabsVendor.modalities).toEqual(["audio"]);
    expect(elevenlabsVendor.defaultApiKeyEnv).toBe("ELEVENLABS_API_KEY");
    const p = provider();
    expect(p.name).toBe("eleven");
    expect(p.vendor).toBe("elevenlabs");
    expect(p.modalities).toEqual(["audio"]);
    expect([...(p.audioKinds ?? [])].sort()).toEqual(["music", "sfx", "speech"]);
    expect(p.maxPerJob).toEqual({ audio: 1 });
    expect(p.poll).toBeUndefined();
  });
});

describe("speech", () => {
  it("POSTs to /v1/text-to-speech/{voice_id}?output_format with xi-api-key and returns done", async () => {
    const { ctx, calls, saved } = makeCtx(() => audioResponse());
    const handle = await provider().start(
      req({ audioKind: "speech", text: TTS_TEXT, voice: VOICE_ID, model: "eleven_multilingual_v2" }),
      ctx,
    );
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`);
    expect(c.headers["xi-api-key"]).toBe("sk-test-key");
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(c.body).toEqual({ text: TTS_TEXT, model_id: "eleven_multilingual_v2" });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ mimeType: "audio/mpeg" });
    expect("bytes" in saved[0]! && Array.from(saved[0].bytes)).toEqual([1, 2, 3, 4]);
    expect(handle.id).toMatch(/^elevenlabs-/);
    expect(handle.done).toHaveLength(1);
  });

  it("defaults to eleven_v4 and maps language and seed", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await provider().start(req({ audioKind: "speech", text: "Hola", voice: VOICE_ID, language: "es-MX", seed: 42 }), ctx);
    expect(calls[0]!.body).toEqual({ text: "Hola", model_id: "eleven_v4", language_code: "es", seed: 42 });
  });

  it("does not send language_code to eleven_multilingual_v2 (documented as unsupported)", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await provider().start(
      req({ audioKind: "speech", text: "Hola", voice: VOICE_ID, language: "es", model: "eleven_multilingual_v2" }),
      ctx,
    );
    expect(calls[0]!.body).toEqual({ text: "Hola", model_id: "eleven_multilingual_v2" });
  });

  it("errors clearly when no voice is given, and uses options.defaultVoice when set", async () => {
    const a = makeCtx(() => audioResponse());
    await expect(provider().start(req({ audioKind: "speech", text: "hi" }), a.ctx)).rejects.toThrow(/requires a voice/);
    expect(a.calls).toHaveLength(0);

    const b = makeCtx(() => audioResponse());
    await provider({ options: { defaultVoice: VOICE_ID } }).start(req({ audioKind: "speech", text: "hi" }), b.ctx);
    expect(b.calls[0]!.url).toContain(`/v1/text-to-speech/${VOICE_ID}`);
  });

  it("rejects text over the model's documented character limit before calling the API", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await expect(
      provider().start(req({ audioKind: "speech", text: "x".repeat(5001), voice: VOICE_ID, model: "eleven_v3" }), ctx),
    ).rejects.toThrow(/5000 per request|at most 5000/);
    expect(calls).toHaveLength(0);
  });

  it("params shallow-merge into the body last; output_format/enable_logging go to the query", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse([9], "audio/wav"));
    await provider().start(
      req({
        audioKind: "speech",
        text: "hi",
        voice: VOICE_ID,
        seed: 1,
        format: "mp3",
        params: {
          output_format: "wav_24000",
          enable_logging: false,
          seed: 7,
          voice_settings: { stability: 0.4, similarity_boost: 0.8 },
        },
      }),
      ctx,
    );
    const c = calls[0]!;
    expect(c.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=wav_24000&enable_logging=false`);
    expect(c.body).toEqual({
      text: "hi",
      model_id: "eleven_v4",
      seed: 7,
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
    });
  });
});

describe("voice name resolution", () => {
  const voicesBody = (voices: { voice_id: string; name: string }[]) => ({ voices, has_more: false, total_count: voices.length });

  it("looks a name up via GET /v2/voices?search= and uses the matching id", async () => {
    const { ctx, calls } = makeCtx((c) =>
      c.url.includes("/v2/voices")
        ? jsonResponse(voicesBody([{ voice_id: VOICE_ID, name: "Roger" }, { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Roger Jr" }]))
        : audioResponse(),
    );
    await provider().start(req({ audioKind: "speech", text: "hi", voice: "roger" }), ctx);
    expect(calls).toHaveLength(2);
    const lookup = calls[0]!;
    expect(lookup.method).toBe("GET");
    expect(lookup.url).toBe("https://api.elevenlabs.io/v2/voices?search=roger&page_size=100");
    expect(lookup.headers["xi-api-key"]).toBe("sk-test-key");
    expect(calls[1]!.url).toContain(`/v1/text-to-speech/${VOICE_ID}?`);
  });

  it("matches the part of a library name before ' - '", async () => {
    const { ctx, calls } = makeCtx((c) =>
      c.url.includes("/v2/voices")
        ? jsonResponse(voicesBody([{ voice_id: VOICE_ID, name: "Brian - Deep, Resonant and Comforting" }]))
        : audioResponse(),
    );
    await provider().start(req({ audioKind: "speech", text: "hi", voice: "Brian" }), ctx);
    expect(calls[1]!.url).toContain(VOICE_ID);
  });

  it("errors when the name is not found", async () => {
    const { ctx, calls } = makeCtx(() => jsonResponse(voicesBody([{ voice_id: VOICE_ID, name: "Roger" }])));
    await expect(provider().start(req({ audioKind: "speech", text: "hi", voice: "Nobody" }), ctx)).rejects.toThrow(
      /no voice named "Nobody"/,
    );
    expect(calls).toHaveLength(1);
  });

  it("errors when the name is ambiguous and lists the ids", async () => {
    const { ctx, calls } = makeCtx(() =>
      jsonResponse(
        voicesBody([
          { voice_id: VOICE_ID, name: "Sam" },
          { voice_id: "pNInz6obpgDQGcFmaJgB", name: "sam" },
        ]),
      ),
    );
    const err = await provider()
      .start(req({ audioKind: "speech", text: "hi", voice: "Sam" }), ctx)
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/ambiguous/);
    expect((err as Error).message).toContain(VOICE_ID);
    expect((err as Error).message).toContain("pNInz6obpgDQGcFmaJgB");
    expect(calls).toHaveLength(1);
  });

  it("does not look up anything for a 20-character id", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await provider().start(req({ audioKind: "speech", text: "hi", voice: VOICE_ID }), ctx);
    expect(calls).toHaveLength(1);
  });
});

describe("sound effects", () => {
  it("POSTs to /v1/sound-generation with text, duration_seconds and the v3 model by default", async () => {
    const { ctx, calls, saved } = makeCtx(() => audioResponse());
    const handle = await provider().start(req({ audioKind: "sfx", prompt: BRAAM, duration: 4.5 }), ctx);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128");
    expect(c.headers["xi-api-key"]).toBe("sk-test-key");
    expect(c.body).toEqual({ text: BRAAM, model_id: "eleven_text_to_sound_v3", duration_seconds: 4.5 });
    expect(saved[0]).toMatchObject({ mimeType: "audio/mpeg", meta: { durationMs: 4500 } });
    expect(handle.done).toHaveLength(1);
  });

  it("omits duration_seconds when none is given and passes loop / prompt_influence through params", async () => {
    const { ctx, calls, saved } = makeCtx(() => audioResponse());
    await provider().start(
      req({ audioKind: "sfx", prompt: BRAAM, params: { loop: true, prompt_influence: 0.7 } }),
      ctx,
    );
    expect(calls[0]!.body).toEqual({
      text: BRAAM,
      model_id: "eleven_text_to_sound_v3",
      loop: true,
      prompt_influence: 0.7,
    });
    expect((saved[0] as { meta?: unknown }).meta).toBeUndefined();
  });

  it("rejects a speech model id for an sfx request", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await expect(provider().start(req({ audioKind: "sfx", prompt: BRAAM, model: "eleven_v4" }), ctx)).rejects.toThrow(
      /speech model/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("music", () => {
  it("POSTs to /v1/music with prompt, music_length_ms and music_v2_5; no output_format by default", async () => {
    const { ctx, calls, saved } = makeCtx(() => audioResponse([5, 6], "audio/mpeg", { "song-id": "song_123" }));
    await provider().start(req({ audioKind: "music", prompt: MUSIC_PROMPT, duration: 10 }), ctx);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.elevenlabs.io/v1/music");
    expect(c.headers["xi-api-key"]).toBe("sk-test-key");
    expect(c.body).toEqual({ model_id: "music_v2_5", prompt: MUSIC_PROMPT, music_length_ms: 10000 });
    expect(saved[0]).toMatchObject({ mimeType: "audio/mpeg", meta: { durationMs: 10000, songId: "song_123" } });
  });

  it("maps instrumental to force_instrumental", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await provider().start(req({ audioKind: "music", prompt: "calm piano", instrumental: true }), ctx);
    expect(calls[0]!.body).toEqual({ model_id: "music_v2_5", prompt: "calm piano", force_instrumental: true });
  });

  it("appends lyrics (text) to the prompt, and refuses lyrics together with instrumental", async () => {
    const a = makeCtx(() => audioResponse());
    await provider().start(req({ audioKind: "music", prompt: "folk ballad", text: "Line one\nLine two" }), a.ctx);
    expect((a.calls[0]!.body as { prompt: string }).prompt).toBe("folk ballad\n\nLyrics:\nLine one\nLine two");

    const b = makeCtx(() => audioResponse());
    await expect(
      provider().start(req({ audioKind: "music", prompt: "folk", text: "la la", instrumental: true }), b.ctx),
    ).rejects.toThrow(/instrumental/);
    expect(b.calls).toHaveLength(0);
  });

  it("enforces the documented 3s..600s length", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await expect(provider().start(req({ audioKind: "music", prompt: "x", duration: 1 }), ctx)).rejects.toThrow(/between 3s and 600s/);
    await expect(provider().start(req({ audioKind: "music", prompt: "x", duration: 700 }), ctx)).rejects.toThrow(/between 3s and 600s/);
    expect(calls).toHaveLength(0);
  });

  it("a params.composition_plan replaces prompt/length/instrumental and merges last", async () => {
    const plan = { chunks: [{ text: "[Intro]", duration_ms: 3000, positive_styles: ["electronic"] }] };
    const { ctx, calls } = makeCtx(() => audioResponse());
    await provider().start(
      req({ audioKind: "music", prompt: "ignored", duration: 30, instrumental: true, params: { composition_plan: plan } }),
      ctx,
    );
    expect(calls[0]!.body).toEqual({ model_id: "music_v2_5", composition_plan: plan });
  });

  it("does not send seed with a prompt (the API forbids the combination)", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await provider().start(req({ audioKind: "music", prompt: "x", seed: 5 }), ctx);
    expect(calls[0]!.body).not.toHaveProperty("seed");
  });

  it("wav is unsupported for music with a pointer to params.output_format", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse());
    await expect(provider().start(req({ audioKind: "music", prompt: "x", format: "wav" }), ctx)).rejects.toThrow(/no wav output_format/);
    expect(calls).toHaveLength(0);
  });
});

describe("format to output_format / mimeType", () => {
  const cases: { kind: "speech" | "sfx" | "music"; format?: string; query: string | null; mime: string }[] = [
    { kind: "speech", format: "mp3", query: "mp3_44100_128", mime: "audio/mpeg" },
    { kind: "speech", format: "wav", query: "wav_44100", mime: "audio/wav" },
    { kind: "speech", format: "opus", query: "opus_48000_128", mime: "audio/ogg" },
    { kind: "sfx", format: "wav", query: "wav_44100", mime: "audio/wav" },
    { kind: "sfx", format: "opus", query: "opus_48000_128", mime: "audio/ogg" },
    { kind: "music", format: "mp3", query: "mp3_44100_128", mime: "audio/mpeg" },
    { kind: "music", format: "opus", query: "opus_48000_128", mime: "audio/ogg" },
    { kind: "music", query: null, mime: "audio/mpeg" },
  ];
  for (const c of cases) {
    it(`${c.kind} ${c.format ?? "(default)"} -> ${c.query ?? "no output_format"} / ${c.mime}`, async () => {
      const { ctx, calls, saved } = makeCtx(() => audioResponse());
      await provider().start(
        req({ audioKind: c.kind, text: "hi", prompt: "p", voice: VOICE_ID, ...(c.format ? { format: c.format } : {}) }),
        ctx,
      );
      const u = new URL(calls[0]!.url);
      expect(u.searchParams.get("output_format")).toBe(c.query);
      expect(saved[0]).toMatchObject({ mimeType: c.mime });
    });
  }

  it("params.output_format picks the mime from its prefix", async () => {
    const { ctx, saved } = makeCtx(() => audioResponse());
    await provider().start(req({ audioKind: "music", prompt: "x", params: { output_format: "pcm_44100" } }), ctx);
    expect(saved[0]).toMatchObject({ mimeType: "audio/pcm" });
  });

  it("ogg and flac are rejected with a clear error", async () => {
    for (const format of ["ogg", "flac"]) {
      const { ctx, calls } = makeCtx(() => audioResponse());
      await expect(provider().start(req({ audioKind: "speech", text: "hi", voice: VOICE_ID, format }), ctx)).rejects.toThrow(
        new RegExp(`format "${format}" is not supported`),
      );
      expect(calls).toHaveLength(0);
    }
  });
});

describe("credentials", () => {
  it("errors when no key is set, naming the env vars", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse(), {});
    await expect(provider().start(req({ audioKind: "sfx", prompt: "boom" }), ctx)).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it("falls back to XI_API_KEY", async () => {
    const { ctx, calls } = makeCtx(() => audioResponse(), { XI_API_KEY: "xi-alt" });
    await provider().start(req({ audioKind: "sfx", prompt: "boom" }), ctx);
    expect(calls[0]!.headers["xi-api-key"]).toBe("xi-alt");
  });

  it("apiKeyEnv selects the variable and disables the defaults", async () => {
    const secrets = { MY_EL_KEY: "custom", ELEVENLABS_API_KEY: "default" };
    const a = makeCtx(() => audioResponse(), secrets);
    await provider({ apiKeyEnv: "MY_EL_KEY" }).start(req({ audioKind: "sfx", prompt: "boom" }), a.ctx);
    expect(a.calls[0]!.headers["xi-api-key"]).toBe("custom");

    const b = makeCtx(() => audioResponse(), { ELEVENLABS_API_KEY: "default" });
    await expect(provider({ apiKeyEnv: "MY_EL_KEY" }).start(req({ audioKind: "sfx", prompt: "boom" }), b.ctx)).rejects.toThrow(/MY_EL_KEY/);
  });

  it("resolves the key per call, not at create()", async () => {
    const secrets: Record<string, string> = {};
    const p = provider();
    secrets.ELEVENLABS_API_KEY = "late-key";
    const { ctx, calls } = makeCtx(() => audioResponse(), secrets);
    await p.start(req({ audioKind: "sfx", prompt: "boom" }), ctx);
    expect(calls[0]!.headers["xi-api-key"]).toBe("late-key");
  });
});

describe("error surfacing", () => {
  async function failWith(status: number, body: unknown, r: Partial<MediaRequest> = {}) {
    const { ctx } = makeCtx(() => jsonResponse(body, status));
    const err = await provider()
      .start(req({ audioKind: "sfx", prompt: "boom", ...r }), ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    return err as VendorHttpError;
  }

  it("401 authentication error", async () => {
    const e = await failWith(401, {
      detail: { type: "authentication_error", code: "invalid_api_key", message: "Invalid API key", status: "invalid_api_key" },
    });
    expect(e.status).toBe(401);
    expect(e.vendor).toBe("elevenlabs");
    expect(e.message).toContain("invalid_api_key");
    expect(e.message).toContain("Invalid API key");
    expect(e.message).not.toContain("sk-test-key");
  });

  it("422 validation error (list of loc/msg)", async () => {
    const e = await failWith(422, { detail: [{ loc: ["body", "duration_seconds"], msg: "ensure this value is <= 30", type: "value_error" }] });
    expect(e.status).toBe(422);
    expect(e.message).toContain("body.duration_seconds");
    expect(e.message).toContain("<= 30");
  });

  it("422/400 object detail shows param and request id", async () => {
    const e = await failWith(400, {
      detail: { type: "validation_error", code: "invalid_parameters", message: "bad model", param: "model_id", request_id: "abc123" },
    });
    expect(e.message).toContain("invalid_parameters: bad model");
    expect(e.message).toContain("param model_id");
    expect(e.message).toContain("abc123");
  });

  it("429 rate / concurrency limit", async () => {
    const e = await failWith(429, {
      detail: { type: "rate_limit_error", code: "concurrent_limit_exceeded", message: "Too many concurrent requests" },
    });
    expect(e.status).toBe(429);
    expect(e.message).toContain("concurrent_limit_exceeded");
  });

  it("music bad_prompt carries the suggested prompt", async () => {
    const { ctx } = makeCtx(() =>
      jsonResponse({ detail: { status: "bad_prompt", message: "copyrighted", data: { prompt_suggestion: "An epic rock ballad" } } }, 400),
    );
    const err = await provider()
      .start(req({ audioKind: "music", prompt: "like Bohemian Rhapsody" }), ctx)
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("bad_prompt");
    expect((err as Error).message).toContain("An epic rock ballad");
  });

  it("non-JSON error bodies are clipped", async () => {
    const { ctx } = makeCtx(() => new Response("x".repeat(2000), { status: 500 }));
    const err = (await provider()
      .start(req({ audioKind: "sfx", prompt: "boom" }), ctx)
      .catch((e: unknown) => e)) as VendorHttpError;
    expect(err.status).toBe(500);
    expect(err.body.length).toBeLessThan(600);
  });

  it("401 on the voice lookup also surfaces as VendorHttpError", async () => {
    const { ctx } = makeCtx(() => jsonResponse({ detail: { status: "invalid_api_key", message: "nope" } }, 401));
    await expect(provider().start(req({ audioKind: "speech", text: "hi", voice: "Roger" }), ctx)).rejects.toBeInstanceOf(VendorHttpError);
  });

  it("a 200 with a JSON body is an error, not an audio file", async () => {
    const { ctx, saved } = makeCtx(() => jsonResponse({ ok: true }));
    await expect(provider().start(req({ audioKind: "sfx", prompt: "boom" }), ctx)).rejects.toThrow(/expected audio/);
    expect(saved).toHaveLength(0);
  });
});

describe("baseUrl and model options", () => {
  it("honors opts.baseUrl (trailing slash tolerated) for generation and voice lookup", async () => {
    const { ctx, calls } = makeCtx((c) =>
      c.url.includes("/v2/voices") ? jsonResponse({ voices: [{ voice_id: VOICE_ID, name: "Roger" }] }) : audioResponse(),
    );
    await provider({ baseUrl: "https://api.eu.residency.elevenlabs.io/" }).start(
      req({ audioKind: "speech", text: "hi", voice: "Roger" }),
      ctx,
    );
    expect(calls[0]!.url.startsWith("https://api.eu.residency.elevenlabs.io/v2/voices?")).toBe(true);
    expect(calls[1]!.url.startsWith(`https://api.eu.residency.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?`)).toBe(true);
  });

  it("opts.model applies only to the kind it belongs to", async () => {
    const p = provider({ model: "eleven_flash_v2_5" });
    const a = makeCtx(() => audioResponse());
    await p.start(req({ audioKind: "speech", text: "hi", voice: VOICE_ID }), a.ctx);
    expect((a.calls[0]!.body as { model_id: string }).model_id).toBe("eleven_flash_v2_5");

    const b = makeCtx(() => audioResponse());
    await p.start(req({ audioKind: "music", prompt: "x" }), b.ctx);
    expect((b.calls[0]!.body as { model_id: string }).model_id).toBe("music_v2_5");
  });

  it("request model wins over per-kind options and provider model", async () => {
    const p = provider({ model: "music_v2", options: { musicModel: "music_v2" } });
    const { ctx, calls } = makeCtx(() => audioResponse());
    await p.start(req({ audioKind: "music", prompt: "x", model: "music_v2_5" }), ctx);
    expect((calls[0]!.body as { model_id: string }).model_id).toBe("music_v2_5");
  });
});

describe("estimateCostUSD (pricing page list prices)", () => {
  const p = provider();
  it("speech is per 1,000 characters by model", () => {
    expect(p.estimateCostUSD!(req({ audioKind: "speech", text: "x".repeat(1000), model: "eleven_v4" }))).toBeCloseTo(0.08);
    expect(p.estimateCostUSD!(req({ audioKind: "speech", text: "x".repeat(500), model: "eleven_flash_v2_5" }))).toBeCloseTo(0.02);
  });
  it("sfx and music are per minute, only with a duration", () => {
    expect(p.estimateCostUSD!(req({ audioKind: "sfx", prompt: "x", duration: 30 }))).toBeCloseTo(0.06);
    expect(p.estimateCostUSD!(req({ audioKind: "music", prompt: "x", duration: 120 }))).toBeCloseTo(0.3);
    expect(p.estimateCostUSD!(req({ audioKind: "music", prompt: "x" }))).toBeUndefined();
  });
  it("unknown models are not guessed", () => {
    expect(p.estimateCostUSD!(req({ audioKind: "speech", text: "hi", model: "eleven_future_v9" }))).toBeUndefined();
  });
});
