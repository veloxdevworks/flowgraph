/**
 * Fixtures follow the official examples (no live calls were made):
 *   - generations: https://developers.openai.com/api/reference/resources/images/methods/generate
 *     (curl example + `{created, data:[{b64_json}], usage:{total_tokens, input_tokens, output_tokens, input_tokens_details}}`)
 *   - edits: https://developers.openai.com/api/reference/resources/images/methods/edit
 *     (multipart `image[]` example, JSON `images:[{image_url}]` example)
 *   - errors: https://developers.openai.com/api/docs/guides/image-generation#handling-blocked-requests-and-other-errors
 *     and https://developers.openai.com/api/docs/guides/error-codes
 *   - rates: https://developers.openai.com/api/docs/pricing (image generation models)
 */

import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "@flowgraph/spec";
import type { MediaCallContext, MediaInput, MediaOutput, MediaProvider, MediaRequest } from "@flowgraph/core";
import { VendorHttpError } from "../http.js";
import { openaiVendor } from "./openai.js";

const KEY = "sk-test-SECRET-1234567890";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function makeCtx(opts: { responses?: Array<Response | (() => Response)>; secrets?: Record<string, string>; signal?: AbortSignal } = {}) {
  const calls: Call[] = [];
  const saved: MediaOutput[] = [];
  const warns: string[] = [];
  const queue = [...(opts.responses ?? [])];
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init as Call["init"] });
    const next = queue.shift();
    if (!next) throw new Error("no more stubbed responses");
    return typeof next === "function" ? next() : next;
  });
  const secrets = opts.secrets ?? { OPENAI_API_KEY: KEY };
  const ctx: MediaCallContext = {
    secrets: { get: async (n) => secrets[n], has: (n) => n in secrets },
    logger: { debug() {}, info() {}, warn: (m) => void warns.push(m), error() {} },
    fetch: fetchStub as unknown as typeof fetch,
    signal: opts.signal,
    saveOutput: async (out) => {
      saved.push(out);
      return {
        kind: "artifact",
        path: `out/${saved.length}`,
        mimeType: out.mimeType ?? "application/octet-stream",
        sizeBytes: "bytes" in out ? out.bytes.length : 0,
      } as Artifact;
    },
  };
  return { ctx, calls, saved, warns };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function input(bytes: Uint8Array, mimeType: string, ref = "ref.png"): MediaInput {
  return {
    ref,
    mimeType,
    identity: ref,
    bytes: async () => bytes,
    dataUri: async () => `data:${mimeType};base64,${b64(bytes)}`,
  };
}

const baseReq = (over: Partial<MediaRequest> = {}): MediaRequest => ({
  modality: "image",
  prompt: "A cute baby sea otter",
  inputs: [],
  count: 1,
  params: {},
  ...over,
});

function provider(opts: Parameters<typeof openaiVendor.create>[0] = { name: "gpt" }): MediaProvider {
  return openaiVendor.create(opts);
}

const docResponse = (extra: Record<string, unknown> = {}) => ({
  created: 1713833628,
  data: [{ b64_json: b64(PNG) }],
  usage: {
    total_tokens: 100,
    input_tokens: 50,
    output_tokens: 50,
    input_tokens_details: { text_tokens: 10, image_tokens: 40 },
  },
  ...extra,
});

describe("openai vendor metadata", () => {
  it("declares the image modality and env var", () => {
    expect(openaiVendor.vendor).toBe("openai");
    expect(openaiVendor.modalities).toEqual(["image"]);
    expect(openaiVendor.defaultApiKeyEnv).toBe("OPENAI_API_KEY");
    const p = provider();
    expect(p.name).toBe("gpt");
    expect(p.maxPerJob?.image).toBe(10);
    expect(p.models?.image).toContain("gpt-image-2.5-sunburst");
  });
});

describe("generations", () => {
  it("POSTs JSON to /images/generations with bearer auth and decodes b64_json", async () => {
    const { ctx, calls, saved } = makeCtx({ responses: [json(docResponse())] });
    const handle = await provider().start(baseReq(), ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "gpt-image-2.5-sunburst",
      prompt: "A cute baby sea otter",
      n: 1,
    });

    expect(saved).toHaveLength(1);
    const out = saved[0]! as { bytes: Uint8Array; mimeType: string; meta?: Record<string, unknown> };
    expect(out.mimeType).toBe("image/png");
    expect(Array.from(out.bytes)).toEqual(Array.from(PNG));
    expect((out.meta?.["openai"] as { usage: { total_tokens: number } }).usage.total_tokens).toBe(100);
    expect(handle.done).toHaveLength(1);
    expect(handle.id).toMatch(/^openai-img-1713833628-/);
  });

  it("maps size, quality, count and model", async () => {
    const { ctx, calls } = makeCtx({
      responses: [json(docResponse({ data: [{ b64_json: b64(PNG) }, { b64_json: b64(PNG) }, { b64_json: b64(PNG) }] }))],
    });
    const handle = await provider({ name: "gpt", model: "gpt-image-2.5-flare" }).start(
      baseReq({ size: "1536X1024", quality: "high", count: 3 }),
      ctx,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      model: "gpt-image-2.5-flare",
      n: 3,
      size: "1536x1024",
      quality: "high",
    });
    expect(handle.done).toHaveLength(3);
  });

  it("request model overrides the provider model; hd maps to high", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(docResponse())] });
    await provider({ name: "gpt", model: "gpt-image-2.5-flare" }).start(baseReq({ model: "gpt-image-2", quality: "hd" }), ctx);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ model: "gpt-image-2", quality: "high" });
  });

  it("derives a size from aspectRatio (arbitrary sizes on gpt-image-2+, snapped on legacy models)", async () => {
    const a = makeCtx({ responses: [json(docResponse()), json(docResponse()), json(docResponse())] });
    const p = provider();
    await p.start(baseReq({ aspectRatio: "16:9" }), a.ctx);
    await p.start(baseReq({ aspectRatio: "1:1" }), a.ctx);
    await p.start(baseReq({ aspectRatio: "2:3" }), a.ctx);
    const sizes = a.calls.map((c) => (JSON.parse(c.init.body as string) as { size: string }).size);
    expect(sizes).toEqual(["1536x864", "1024x1024", "1024x1536"]);

    const legacy = makeCtx({ responses: [json(docResponse())] });
    await p.start(baseReq({ model: "gpt-image-1.5", aspectRatio: "16:9" }), legacy.ctx);
    expect(JSON.parse(legacy.calls[0]!.init.body as string).size).toBe("1536x1024");
    expect(legacy.warns.some((w) => w.includes("snapped"))).toBe(true);
  });

  it("explicit size wins over aspectRatio, and bad inputs are rejected", async () => {
    const { ctx, calls, warns } = makeCtx({ responses: [json(docResponse())] });
    await provider().start(baseReq({ size: "auto", aspectRatio: "16:9" }), ctx);
    expect(JSON.parse(calls[0]!.init.body as string).size).toBe("auto");
    expect(warns.some((w) => w.includes("aspectRatio"))).toBe(true);

    const p = provider();
    await expect(p.start(baseReq({ aspectRatio: "5:1" }), makeCtx().ctx)).rejects.toThrow(/1:3 to 3:1/);
    await expect(p.start(baseReq({ size: "big" }), makeCtx().ctx)).rejects.toThrow(/unsupported size/);
    await expect(p.start(baseReq({ count: 11 }), makeCtx().ctx)).rejects.toThrow(/between 1 and 10/);
    await expect(p.start(baseReq({ prompt: " " }), makeCtx().ctx)).rejects.toThrow(/prompt is required/);
    await expect(p.start(baseReq({ params: { stream: true } }), makeCtx().ctx)).rejects.toThrow(/streaming/);
  });

  it("merges params last (shallow) and uses output_format for the saved mime type", async () => {
    const { ctx, calls, saved } = makeCtx({ responses: [json(docResponse())] });
    await provider().start(
      baseReq({
        quality: "low",
        params: { background: "transparent", output_format: "webp", output_compression: 80, moderation: "low", quality: "medium", n: 2 },
      }),
      ctx,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "gpt-image-2.5-sunburst",
      prompt: "A cute baby sea otter",
      n: 2,
      quality: "medium",
      background: "transparent",
      output_format: "webp",
      output_compression: 80,
      moderation: "low",
    });
    expect(saved[0]!.mimeType).toBe("image/webp");
  });

  it("prefers the response output_format for the mime type, and maps jpeg", async () => {
    const { ctx, saved } = makeCtx({ responses: [json(docResponse({ output_format: "jpeg" }))] });
    await provider().start(baseReq({ params: { output_format: "png" } }), ctx);
    expect(saved[0]!.mimeType).toBe("image/jpeg");
  });

  it("applies provider option defaults under request params and sends org/project headers", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(docResponse())] });
    await provider({
      name: "gpt",
      options: { organization: "org-123", project: "proj_456", params: { moderation: "low", background: "opaque" } },
    }).start(baseReq({ params: { background: "auto" } }), ctx);
    expect(calls[0]!.init.headers["OpenAI-Organization"]).toBe("org-123");
    expect(calls[0]!.init.headers["OpenAI-Project"]).toBe("proj_456");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ moderation: "low", background: "auto" });
  });

  it("warns on negativePrompt, ignores seed, and never sends either", async () => {
    const { ctx, calls, warns } = makeCtx({ responses: [json(docResponse())] });
    await provider().start(baseReq({ negativePrompt: "blurry", seed: 7 }), ctx);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).not.toHaveProperty("negative_prompt");
    expect(body).not.toHaveProperty("seed");
    expect(JSON.stringify(body)).not.toContain("blurry");
    expect(warns.some((w) => w.includes("negativePrompt"))).toBe(true);
  });

  it("saves url results by reference when a proxy returns urls", async () => {
    const { ctx, saved } = makeCtx({ responses: [json({ created: 1, data: [{ url: "https://cdn.example/x.png" }] })] });
    await provider().start(baseReq(), ctx);
    expect(saved[0]).toMatchObject({ url: "https://cdn.example/x.png", mimeType: "image/png" });
  });

  it("fails when the response has no images", async () => {
    const { ctx } = makeCtx({ responses: [json({ created: 1, data: [] })] });
    await expect(provider().start(baseReq(), ctx)).rejects.toThrow(/no images/);
  });
});

describe("baseUrl, auth and errors", () => {
  it("honors a baseUrl override (proxy), including a trailing slash", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(docResponse())] });
    await provider({ name: "gpt", baseUrl: "https://proxy.internal/openai/v1/" }).start(baseReq(), ctx);
    expect(calls[0]!.url).toBe("https://proxy.internal/openai/v1/images/generations");
  });

  it("resolves the key from apiKeyEnv per call", async () => {
    const { ctx, calls } = makeCtx({ secrets: { MY_KEY: "k-custom" }, responses: [json(docResponse())] });
    await provider({ name: "gpt", apiKeyEnv: "MY_KEY" }).start(baseReq(), ctx);
    expect(calls[0]!.init.headers["Authorization"]).toBe("Bearer k-custom");
  });

  it("throws a clear error when no key is set, without calling the network", async () => {
    const { ctx, calls } = makeCtx({ secrets: {} });
    await expect(provider().start(baseReq(), ctx)).rejects.toThrow(/openai: no API key\. Set OPENAI_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces API errors as VendorHttpError without leaking the key", async () => {
    const body = {
      error: {
        message: `Incorrect API key provided: ${KEY}.`,
        type: "invalid_request_error",
        code: "invalid_api_key",
        param: null,
      },
    };
    const { ctx } = makeCtx({ responses: [json(body, 401)] });
    const err = await provider()
      .start(baseReq(), ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    const e = err as VendorHttpError;
    expect(e.status).toBe(401);
    expect(e.message).toContain("openai: HTTP 401");
    expect(e.message).toContain("invalid_api_key");
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain("sk-test");
  });

  it("includes moderation details for image_generation_user_error", async () => {
    const body = {
      error: {
        message: "Your request was rejected by the safety system.",
        type: "image_generation_user_error",
        code: "moderation_blocked",
        moderation_details: { moderation_stage: "input", categories: ["harassment"] },
      },
    };
    const { ctx } = makeCtx({ responses: [json(body, 400)] });
    await expect(provider().start(baseReq(), ctx)).rejects.toThrow(/moderation_blocked.*harassment/);
  });

  it("keeps raw text for non-JSON error bodies", async () => {
    const { ctx } = makeCtx({ responses: [new Response("Bad gateway", { status: 502 })] });
    await expect(provider().start(baseReq(), ctx)).rejects.toThrow("openai: HTTP 502: Bad gateway");
  });
});

describe("edits", () => {
  it("sends multipart with image[] parts carrying correct mime types and fields", async () => {
    const { ctx, calls, saved } = makeCtx({ responses: [json(docResponse())] });
    await provider().start(
      baseReq({
        prompt: "Create a lovely gift basket with these four items in it",
        inputs: [input(PNG, "image/png", "a.png"), input(JPG, "application/octet-stream", "b.jpg")],
        size: "1024x1024",
        quality: "medium",
        count: 2,
        params: { input_fidelity: "high", output_format: "jpeg", background: "opaque" },
      }),
      ctx,
    );

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/edits");
    expect(calls[0]!.init.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    // fetch must set the multipart boundary itself
    expect(calls[0]!.init.headers["Content-Type"]).toBeUndefined();

    const form = calls[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-image-2.5-sunburst");
    expect(form.get("prompt")).toBe("Create a lovely gift basket with these four items in it");
    expect(form.get("n")).toBe("2");
    expect(form.get("size")).toBe("1024x1024");
    expect(form.get("quality")).toBe("medium");
    expect(form.get("input_fidelity")).toBe("high");
    expect(form.get("output_format")).toBe("jpeg");

    const files = form.getAll("image[]") as File[];
    expect(files).toHaveLength(2);
    expect(files[0]!.type).toBe("image/png");
    expect(files[0]!.name).toBe("image-1.png");
    // declared octet-stream, sniffed as JPEG
    expect(files[1]!.type).toBe("image/jpeg");
    expect(files[1]!.name).toBe("image-2.jpg");
    expect(Array.from(new Uint8Array(await files[0]!.arrayBuffer()))).toEqual(Array.from(PNG));

    expect(saved[0]!.mimeType).toBe("image/jpeg");
  });

  it("uses generations when there are no inputs and edits when there are", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(docResponse()), json(docResponse())] });
    const p = provider();
    await p.start(baseReq(), ctx);
    await p.start(baseReq({ inputs: [input(PNG, "image/png")] }), ctx);
    expect(calls.map((c) => c.url.split("/").slice(-2).join("/"))).toEqual(["images/generations", "images/edits"]);
  });

  it("switches to the JSON edit form when params carry object values (mask / markup)", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(docResponse())] });
    await provider().start(
      baseReq({
        prompt: "Replace the background with a snowy mountain scene",
        inputs: [input(PNG, "image/png")],
        params: { mask: { file_id: "file-mask123" }, output_format: "png" },
      }),
      ctx,
    );
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/edits");
    expect(calls[0]!.init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.mask).toEqual({ file_id: "file-mask123" });
    expect(body.images).toEqual([{ image_url: `data:image/png;base64,${b64(PNG)}` }]);
    expect(body.prompt).toBe("Replace the background with a snowy mountain scene");
  });

  it("rejects more than 16 input images before any request", async () => {
    const { ctx, calls } = makeCtx();
    const inputs = Array.from({ length: 17 }, (_, i) => input(PNG, "image/png", `i${i}.png`));
    await expect(provider().start(baseReq({ inputs }), ctx)).rejects.toThrow(/at most 16 input images \(got 17\)/);
    expect(calls).toHaveLength(0);
  });

  it("accepts exactly 16 inputs", async () => {
    const { ctx, calls } = makeCtx({ responses: [json(docResponse())] });
    const inputs = Array.from({ length: 16 }, (_, i) => input(PNG, "image/png", `i${i}.png`));
    await provider().start(baseReq({ inputs }), ctx);
    expect((calls[0]!.init.body as FormData).getAll("image[]")).toHaveLength(16);
  });

  it("rejects unsupported input types with the offending ref", async () => {
    const { ctx, calls } = makeCtx();
    await expect(
      provider().start(baseReq({ inputs: [input(Uint8Array.from([1, 2, 3, 4]), "image/bmp", "pic.bmp")] }), ctx),
    ).rejects.toThrow(/pic\.bmp.*png, jpeg or webp/);
    expect(calls).toHaveLength(0);
  });
});

describe("cost", () => {
  it("reports cost from vendor usage and documented rates on the job handle", async () => {
    const { ctx } = makeCtx({
      responses: [
        json(
          docResponse({
            usage: {
              input_tokens: 1000,
              input_tokens_details: { text_tokens: 1000, image_tokens: 0 },
              output_tokens: 1056,
              total_tokens: 2056,
            },
          }),
        ),
      ],
    });
    const p = provider();
    expect(p.estimateCostUSD).toBeUndefined(); // no reliable up-front estimate for token pricing
    const handle = await p.start(baseReq(), ctx);
    // 1000 * $5/M + 1056 * $30/M = 0.005 + 0.03168
    expect(handle.costUSD).toBeCloseTo(0.03668, 6);
  });

  it("reports no cost for custom base URLs and unknown models", async () => {
    const a = makeCtx({ responses: [json(docResponse())] });
    const proxied = provider({ name: "gpt", baseUrl: "https://proxy.example/v1" });
    expect((await proxied.start(baseReq(), a.ctx)).costUSD).toBeUndefined();

    const b = makeCtx({ responses: [json(docResponse())] });
    const p = provider();
    expect((await p.start(baseReq({ model: "some-future-model" }), b.ctx)).costUSD).toBeUndefined();
  });
});
