import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "@flowgraph/spec";
import type { MediaCallContext, MediaInput, MediaOutput, MediaRequest } from "@flowgraph/core";
import { VendorHttpError } from "../http.js";
import { xaiVendor } from "./xai.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeCtx(opts: { secrets?: Record<string, string>; responses: Response[] }) {
  const calls: Call[] = [];
  const saved: MediaOutput[] = [];
  const queue = [...opts.responses];
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next;
  });
  const secrets = opts.secrets ?? { XAI_API_KEY: "test-key" };
  const ctx: MediaCallContext = {
    secrets: { get: async (n) => secrets[n], has: (n) => n in secrets },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: fetchStub as unknown as typeof fetch,
    saveOutput: async (out) => {
      saved.push(out);
      return { id: `art-${saved.length}` } as unknown as Artifact;
    },
  };
  return { ctx, calls, saved };
}

function req(over: Partial<MediaRequest>): MediaRequest {
  return { modality: "image", inputs: [], count: 1, params: {}, ...over };
}

function input(over: Partial<MediaInput> = {}): MediaInput {
  return {
    ref: "test",
    mimeType: "image/png",
    identity: "id",
    bytes: async () => new Uint8Array([1, 2, 3]),
    dataUri: async () => "data:image/png;base64,AQID",
    ...over,
  };
}

const provider = (o: Partial<Parameters<typeof xaiVendor.create>[0]> = {}) => xaiVendor.create({ name: "grok", ...o });

describe("xai vendor metadata", () => {
  it("declares image + video and the default env var", () => {
    expect(xaiVendor.vendor).toBe("xai");
    expect(xaiVendor.modalities).toEqual(["image", "video"]);
    expect(xaiVendor.defaultApiKeyEnv).toBe("XAI_API_KEY");
    const p = provider();
    expect(p.maxPerJob).toEqual({ image: 10, video: 1 });
    expect(p.cancel).toBeUndefined();
  });
});

describe("api key resolution", () => {
  const ok = () => json(200, { data: [{ url: "https://img/1.jpg" }] });

  it("uses XAI_API_KEY as a Bearer token", async () => {
    const { ctx, calls } = makeCtx({ secrets: { XAI_API_KEY: "k1" }, responses: [ok()] });
    await provider().start(req({ prompt: "hi" }), ctx);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer k1");
  });

  it("falls back to GROK_API_KEY", async () => {
    const { ctx, calls } = makeCtx({ secrets: { GROK_API_KEY: "g1" }, responses: [ok()] });
    await provider().start(req({ prompt: "hi" }), ctx);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer g1");
  });

  it("honors a custom apiKeyEnv without the GROK fallback", async () => {
    const a = makeCtx({ secrets: { MY_KEY: "m1", GROK_API_KEY: "g1" }, responses: [ok()] });
    await provider({ apiKeyEnv: "MY_KEY" }).start(req({ prompt: "hi" }), a.ctx);
    expect(a.calls[0]!.headers["Authorization"]).toBe("Bearer m1");

    const b = makeCtx({ secrets: { GROK_API_KEY: "g1" }, responses: [] });
    await expect(provider({ apiKeyEnv: "MY_KEY" }).start(req({ prompt: "hi" }), b.ctx)).rejects.toThrow(/MY_KEY/);
  });

  it("throws a clear error naming the env vars when no key is set, without making a request", async () => {
    const { ctx, calls } = makeCtx({ secrets: {}, responses: [] });
    await expect(provider().start(req({ prompt: "hi" }), ctx)).rejects.toThrow(/XAI_API_KEY or GROK_API_KEY/);
    expect(calls).toHaveLength(0);
  });
});

describe("image generation (sync)", () => {
  // Fixture: https://docs.x.ai/developers/model-capabilities/images/generation.md (Quick Start curl) and
  // https://docs.x.ai/developers/rest-api-reference/inference/images.md (response example `{ data: [{ url }] }`).
  it("POSTs /images/generations and returns done artifacts from start", async () => {
    const { ctx, calls, saved } = makeCtx({
      responses: [json(200, { data: [{ url: "https://imgen.x.ai/a.jpg", mime_type: "image/jpeg" }] })],
    });
    const handle = await provider().start(
      req({ prompt: "A collage of London landmarks in a stenciled street‑art style" }),
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.x.ai/v1/images/generations",
      method: "POST",
      body: {
        model: "grok-imagine-image-2.0",
        prompt: "A collage of London landmarks in a stenciled street‑art style",
        response_format: "url",
      },
    });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).not.toHaveProperty("n");
    expect(saved).toEqual([{ url: "https://imgen.x.ai/a.jpg", mimeType: "image/jpeg" }]);
    expect(handle.done).toHaveLength(1);
    expect(handle.id).toBeTruthy();
  });

  // Fixture: generation.md "Multiple Images" (n=4), "Aspect Ratio" (16:9), "Resolution" (2k), "Quality" (low).
  it("maps count, aspect ratio, resolution and quality", async () => {
    const { ctx, calls, saved } = makeCtx({
      responses: [json(200, { data: [{ url: "https://i/1" }, { url: "https://i/2" }, { url: "https://i/3" }, { url: "https://i/4" }] })],
    });
    const h = await provider().start(
      req({ prompt: "A futuristic city skyline at night", count: 4, aspectRatio: "16:9", resolution: "2K", quality: "low" }),
      ctx,
    );
    expect(calls[0]!.body).toMatchObject({ n: 4, aspect_ratio: "16:9", resolution: "2k", quality: "low" });
    expect(h.done).toHaveLength(4);
    expect(saved[0]).toEqual({ url: "https://i/1" });
  });

  it("treats a 1k/2k `size` as the resolution and rejects pixel sizes", async () => {
    const a = makeCtx({ responses: [json(200, { data: [{ url: "https://i/1" }] })] });
    await provider().start(req({ prompt: "x", size: "2k" }), a.ctx);
    expect(a.calls[0]!.body).toMatchObject({ resolution: "2k" });
    const b = makeCtx({ responses: [] });
    await expect(provider().start(req({ prompt: "x", size: "1024x1024" }), b.ctx)).rejects.toThrow(/size/);
  });

  // Fixture: generation.md "Base64 Output" (response_format b64_json; image bytes returned without data-URI prefix).
  it("decodes b64_json responses into bytes", async () => {
    const { ctx, calls, saved } = makeCtx({
      responses: [json(200, { data: [{ b64_json: Buffer.from("PNGDATA").toString("base64"), mime_type: "image/png" }] })],
    });
    await provider({ options: { responseFormat: "b64_json" } }).start(req({ prompt: "A serene Japanese garden" }), ctx);
    expect(calls[0]!.body).toMatchObject({ response_format: "b64_json" });
    expect(saved).toHaveLength(1);
    const out = saved[0] as { bytes: Uint8Array; mimeType: string };
    expect(Buffer.from(out.bytes).toString()).toBe("PNGDATA");
    expect(out.mimeType).toBe("image/png");
  });

  it("uses opts.model and rejects `quality` on the 1.0 model", async () => {
    const a = makeCtx({ responses: [json(200, { data: [{ url: "https://i/1" }] })] });
    await provider({ model: "grok-imagine-image" }).start(req({ prompt: "x" }), a.ctx);
    expect(a.calls[0]!.body).toMatchObject({ model: "grok-imagine-image" });
    const b = makeCtx({ responses: [] });
    await expect(provider({ model: "grok-imagine-image" }).start(req({ prompt: "x", quality: "low" }), b.ctx)).rejects.toThrow(/quality/);
  });

  it("lets req.model override opts.model and rejects unsupported fields", async () => {
    const a = makeCtx({ responses: [json(200, { data: [{ url: "https://i/1" }] })] });
    await provider({ model: "grok-imagine-image" }).start(req({ prompt: "x", model: "grok-imagine-image-2.0" }), a.ctx);
    expect(a.calls[0]!.body).toMatchObject({ model: "grok-imagine-image-2.0" });
    const b = makeCtx({ responses: [] });
    await expect(provider().start(req({ prompt: "x", negativePrompt: "blur" }), b.ctx)).rejects.toThrow(/negativePrompt/);
    await expect(provider().start(req({ prompt: "x", count: 11 }), b.ctx)).rejects.toThrow(/1-10/);
    await expect(provider().start(req({}), b.ctx)).rejects.toThrow(/prompt/);
  });

  it("errors clearly when the response has no images", async () => {
    const { ctx } = makeCtx({ responses: [json(200, { data: [{ url: null }] })] });
    await expect(provider().start(req({ prompt: "x" }), ctx)).rejects.toThrow(/no images/);
  });
});

describe("image editing", () => {
  // Fixture: https://docs.x.ai/developers/model-capabilities/images/editing.md (curl with a public URL source).
  it("POSTs /images/edits with a single `image` for a URL reference", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(200, { data: [{ url: "https://i/edit.jpg" }] })] });
    const url = "https://docs.x.ai/assets/api-examples/images/style-realistic.png";
    const h = await provider().start(
      req({ prompt: "Render this as a pencil sketch with detailed shading", inputs: [input({ url })] }),
      ctx,
    );
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/images/edits");
    expect(calls[0]!.body).toMatchObject({
      model: "grok-imagine-image-2.0",
      prompt: "Render this as a pencil sketch with detailed shading",
      image: { url, type: "image_url" },
    });
    expect(calls[0]!.body).not.toHaveProperty("images");
    expect(h.done).toHaveLength(1);
  });

  // Fixture: editing.md (base64 data URI source, JSON body) + multi-image-editing.md (up to 5 sources, `images`).
  it("sends local inputs as data URIs and several inputs as `images`", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(200, { data: [{ url: "https://i/edit.jpg" }] })] });
    await provider().start(
      req({ prompt: "Blend <IMAGE_0> and <IMAGE_1>", inputs: [input(), input({ url: "https://x/y.png" })] }),
      ctx,
    );
    expect(calls[0]!.body).toMatchObject({
      images: [
        { url: "data:image/png;base64,AQID", type: "image_url" },
        { url: "https://x/y.png", type: "image_url" },
      ],
    });
    expect(calls[0]!.body).not.toHaveProperty("image");
  });

  it("rejects more than 5 sources and multi-image on the 1.0 model", async () => {
    const { ctx } = makeCtx({ responses: [] });
    await expect(
      provider().start(req({ prompt: "x", inputs: Array.from({ length: 6 }, () => input()) }), ctx),
    ).rejects.toThrow(/at most 5/);
    await expect(
      provider({ model: "grok-imagine-image" }).start(req({ prompt: "x", inputs: [input(), input()] }), ctx),
    ).rejects.toThrow(/multi-image/);
  });
});

describe("video generation", () => {
  // Fixtures: https://docs.x.ai/developers/model-capabilities/video/generation.md ("How it works", Step 1/Step 2).
  const START_RESPONSE = { request_id: "d97415a1-5796-b7ec-379f-4e6819e08fdf" };

  it("submits text-to-video and returns a pending handle", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(200, START_RESPONSE)] });
    const h = await provider().start(
      req({ modality: "video", prompt: "A glowing crystal-powered rocket launching from Mars", duration: 10, aspectRatio: "16:9", resolution: "720p" }),
      ctx,
    );
    expect(calls[0]).toMatchObject({
      url: "https://api.x.ai/v1/videos/generations",
      method: "POST",
      body: {
        model: "grok-imagine-video-1.5",
        prompt: "A glowing crystal-powered rocket launching from Mars",
        duration: 10,
        aspect_ratio: "16:9",
        resolution: "720p",
      },
    });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer test-key");
    expect(h.id).toBe(START_RESPONSE.request_id);
    expect(h.done).toBeUndefined();
  });

  // Fixture: imagine.md "Video Generation" curl (image-to-video with `image: {url}` and duration 12).
  it("maps a single input to image-to-video", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(200, START_RESPONSE)] });
    const url = "https://docs.x.ai/assets/api-examples/video/waterfall-still.png";
    await provider().start(
      req({ modality: "video", prompt: "Make the water crash down and slowly pan out the camera", duration: 12, inputs: [input({ url })] }),
      ctx,
    );
    expect(calls[0]!.body).toMatchObject({ image: { url }, duration: 12 });
    expect(calls[0]!.body).not.toHaveProperty("reference_images");
  });

  // Fixture: video/reference-to-video.md (reference_images: [{url}]; up to 14 on 1.5, 7 on grok-imagine-video).
  it("maps several inputs to reference_images and enforces model limits", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(200, START_RESPONSE)] });
    await provider().start(
      req({ modality: "video", prompt: "runway", inputs: [input({ url: "https://a/1.png" }), input({ url: "https://a/2.png" })] }),
      ctx,
    );
    expect(calls[0]!.body).toMatchObject({ reference_images: [{ url: "https://a/1.png" }, { url: "https://a/2.png" }] });
    expect(calls[0]!.body).not.toHaveProperty("image");

    const two = [input(), input()];
    await expect(provider({ model: "grok-imagine-video-1.5-lite" }).start(req({ modality: "video", prompt: "x", inputs: two }), ctx)).rejects.toThrow(/reference images/);
    await expect(
      provider({ model: "grok-imagine-video" }).start(req({ modality: "video", prompt: "x", inputs: Array.from({ length: 8 }, () => input()) }), ctx),
    ).rejects.toThrow(/at most 7/);
  });

  it("validates duration, prompt and count", async () => {
    const { ctx } = makeCtx({ responses: [] });
    const p = provider();
    await expect(p.start(req({ modality: "video", prompt: "x", duration: 16 }), ctx)).rejects.toThrow(/1-15/);
    await expect(p.start(req({ modality: "video" }), ctx)).rejects.toThrow(/prompt/);
    await expect(p.start(req({ modality: "video", prompt: "x", count: 2 }), ctx)).rejects.toThrow(/count/);
    await expect(p.start(req({ modality: "audio" as never, prompt: "x" }), ctx)).rejects.toThrow(/unsupported modality/);
  });

  it("polls: pending (no progress) -> queued, pending with progress -> running", async () => {
    const { ctx, calls } = makeCtx({
      responses: [json(200, { status: "pending" }), json(200, { status: "pending", progress: 40 })],
    });
    const p = provider();
    expect(await p.poll!({ id: "rid" }, ctx)).toEqual({ state: "queued" });
    expect(await p.poll!({ id: "rid" }, ctx)).toEqual({ state: "running", progress: 40 });
    expect(calls[0]).toMatchObject({ url: "https://api.x.ai/v1/videos/rid", method: "GET" });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer test-key");
  });

  // Fixture: generation.md "Response (when complete)" and rest-api-reference/inference/videos.md GET example.
  it("polls: done reports cost from usage ticks; fetch saves the URL with duration", async () => {
    const done = {
      status: "done",
      video: { url: "https://vidgen.x.ai/xai-vidgen-bucket/xai-video-rid.mp4", duration: 8, respect_moderation: true },
      model: "grok-imagine-video-1.5",
      usage: { cost_in_usd_ticks: 6_400_000_000 },
    };
    const { ctx, saved } = makeCtx({ responses: [json(200, done), json(200, done)] });
    const p = provider();
    expect(await p.poll!({ id: "rid" }, ctx)).toEqual({ state: "done", progress: 100, costUSD: 0.64 });
    const arts = await p.fetch!({ id: "rid" }, ctx);
    expect(arts).toHaveLength(1);
    expect(saved).toEqual([
      { url: done.video.url, mimeType: "video/mp4", meta: { durationMs: 8000 } },
    ]);
  });

  // Fixture: generation.md "Error Handling" (status failed with error { code, message }).
  it("polls: failed surfaces the vendor code and message", async () => {
    const { ctx } = makeCtx({
      responses: [json(200, { status: "failed", error: { code: "invalid_argument", message: "Prompt cannot be empty. Please provide a prompt." } })],
    });
    expect(await provider().poll!({ id: "rid" }, ctx)).toEqual({
      state: "failed",
      error: "invalid_argument: Prompt cannot be empty. Please provide a prompt.",
    });
  });

  it("polls: expired and moderation-withheld results fail", async () => {
    const { ctx } = makeCtx({
      responses: [
        json(200, { status: "expired" }),
        json(200, { status: "done", video: { url: "", duration: 8, respect_moderation: false } }),
      ],
    });
    const p = provider();
    expect(await p.poll!({ id: "rid" }, ctx)).toMatchObject({ state: "failed", error: expect.stringMatching(/expired/) });
    expect(await p.poll!({ id: "rid" }, ctx)).toMatchObject({ state: "failed", error: expect.stringMatching(/moderation/) });
  });

  it("fetch throws when the job is not done", async () => {
    const { ctx } = makeCtx({ responses: [json(200, { status: "pending" })] });
    await expect(provider().fetch!({ id: "rid" }, ctx)).rejects.toThrow(/not ready/);
  });
});

describe("params passthrough, baseUrl and errors", () => {
  it("merges req.params last, overriding mapped fields", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(200, { data: [{ url: "https://i/1" }] })] });
    await provider().start(
      req({ prompt: "x", aspectRatio: "1:1", params: { aspect_ratio: "auto", user: "u-1", model: "grok-imagine-image" } }),
      ctx,
    );
    expect(calls[0]!.body).toMatchObject({ aspect_ratio: "auto", user: "u-1", model: "grok-imagine-image" });
  });

  it("passes video params such as generate_audio and last_frame", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(200, { request_id: "r" })] });
    await provider().start(
      req({ modality: "video", prompt: "A paper boat drifting down a rain-soaked street", params: { generate_audio: false } }),
      ctx,
    );
    expect(calls[0]!.body).toMatchObject({ generate_audio: false });
    const b = makeCtx({ responses: [json(200, { request_id: "r" })] });
    await provider().start(req({ modality: "video", params: { last_frame: { url: "https://a/end.png" } } }), b.ctx);
    expect(b.calls[0]!.body).toMatchObject({ last_frame: { url: "https://a/end.png" } });
  });

  it("honors a baseUrl override (with trailing slash) for submit and poll", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(200, { request_id: "r1" }), json(200, { status: "pending" })] });
    const p = provider({ baseUrl: "https://proxy.example.com/xai/" });
    await p.start(req({ modality: "video", prompt: "x" }), ctx);
    await p.poll!({ id: "r1" }, ctx);
    expect(calls[0]!.url).toBe("https://proxy.example.com/xai/videos/generations");
    expect(calls[1]!.url).toBe("https://proxy.example.com/xai/videos/r1");
  });

  it("raises VendorHttpError for HTTP errors without leaking the key", async () => {
    // Body shape observed from api.x.ai for a bad key (not documented): { code, error }.
    const { ctx } = makeCtx({
      secrets: { XAI_API_KEY: "super-secret-key" },
      responses: [json(401, { code: "invalid-argument", error: "Incorrect API key provided." })],
    });
    const err = await provider().start(req({ prompt: "x" }), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect((err as VendorHttpError).status).toBe(401);
    expect((err as Error).message).toContain("Incorrect API key provided");
    expect((err as Error).message).not.toContain("super-secret-key");
  });

  it("rejects a deferred image response it cannot handle", async () => {
    const { ctx } = makeCtx({ responses: [json(200, { request_id: "img-1" })] });
    await expect(provider().start(req({ prompt: "x", params: { deferred: true } }), ctx)).rejects.toThrow(/deferred/);
  });
});

describe("estimateCostUSD", () => {
  const p = provider();
  it("prices video per second from the models page", () => {
    expect(p.estimateCostUSD!(req({ modality: "video", duration: 10 }))).toBeCloseTo(0.8);
    expect(p.estimateCostUSD!(req({ modality: "video" }))).toBeCloseTo(0.64);
    expect(p.estimateCostUSD!(req({ modality: "video", model: "grok-imagine-video-1.5-lite", duration: 5 }))).toBeCloseTo(0.1);
    expect(p.estimateCostUSD!(req({ modality: "video", model: "grok-imagine-video", duration: 4 }))).toBeCloseTo(0.2);
    expect(p.estimateCostUSD!(req({ modality: "video", model: "mystery" }))).toBeUndefined();
  });
  it("prices documented image tiers only", () => {
    expect(p.estimateCostUSD!(req({ count: 3 }))).toBeCloseTo(0.12);
    expect(p.estimateCostUSD!(req({ resolution: "2k" }))).toBeCloseTo(0.06);
    expect(p.estimateCostUSD!(req({ quality: "medium" }))).toBeUndefined();
    expect(p.estimateCostUSD!(req({ resolution: "1.5k" }))).toBeUndefined();
    expect(p.estimateCostUSD!(req({ model: "grok-imagine-image", count: 2 }))).toBeCloseTo(0.04);
    // edits: $0.01 per input image on top, but auto quality on edits is medium (undocumented price)
    expect(p.estimateCostUSD!(req({ quality: "low", inputs: [input(), input()] }))).toBeCloseTo(0.06);
    expect(p.estimateCostUSD!(req({ inputs: [input()] }))).toBeUndefined();
  });
});

describe("image cost on the job handle", () => {
  it("reports the vendor's actual cost (ticks / 1e10) from an image response", async () => {
    const { ctx } = makeCtx({
      responses: [json(200, { data: [{ url: "https://imgen.x.ai/a.png", mime_type: "image/png" }], usage: { cost_in_usd_ticks: 400000000 } })],
    });
    const handle = await provider().start(req({ prompt: "a lighthouse" }), ctx);
    expect(handle.costUSD).toBeCloseTo(0.04, 8);
  });
});
