/**
 * Offline tests for the Tripo adapter. Fixtures are the request/response examples printed in the
 * official docs (nothing here was observed from a live API):
 *   https://developers.tripo3d.ai/en/docs/quick-start
 *   https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard
 *   https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard
 *   https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard
 *   https://developers.tripo3d.ai/en/docs/models-convert
 *   https://developers.tripo3d.ai/en/docs/files
 *   https://developers.tripo3d.ai/en/docs/task-query
 *   https://developers.tripo3d.ai/en/docs/error-handling
 */

import { describe, expect, it, vi } from "vitest";
import type { JobHandle, MediaCallContext, MediaInput, MediaOutput, MediaProvider, MediaRequest } from "@flowgraph/core";
import { VendorHttpError } from "../http.js";
import { tripoVendor } from "./tripo.js";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const KEY = "tsk_test_secret_key";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
}

function makeCtx(replies: Reply[], secrets: Record<string, string> = { TRIPO_API_KEY: KEY }) {
  const calls: Call[] = [];
  const events: string[] = [];
  const saved: MediaOutput[] = [];
  const queue = [...replies];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({
      url: u,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    events.push(`${method} ${new URL(u).pathname}`);
    const r = queue.shift();
    if (!r) throw new Error(`unexpected extra fetch: ${method} ${u}`);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  });
  const warn = vi.fn();
  const ctx: MediaCallContext = {
    secrets: { get: async (n) => secrets[n], has: (n) => n in secrets },
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    fetch: fetchFn as unknown as typeof fetch,
    saveOutput: async (out) => {
      saved.push(out);
      events.push(`saveOutput ${"url" in out ? out.url : "bytes"}`);
      return {
        kind: "artifact",
        path: `.flowgraph/artifacts/n/job-${saved.length - 1}.bin`,
        mimeType: ("mimeType" in out && out.mimeType) || "application/octet-stream",
        sizeBytes: 1,
        ...(out.meta ? { meta: out.meta } : {}),
      };
    },
  };
  return { ctx, calls, events, saved, warn, fetchFn };
}

function provider(opts: { baseUrl?: string; model?: string; apiKeyEnv?: string; options?: Record<string, unknown> } = {}): MediaProvider {
  return tripoVendor.create({ name: "tripo-test", ...opts });
}

function req(over: Partial<MediaRequest> = {}): MediaRequest {
  return { modality: "model3d", inputs: [], count: 1, params: {}, ...over };
}

function input(over: Partial<MediaInput> & { ref: string }): MediaInput {
  return {
    mimeType: "image/png",
    identity: over.ref,
    bytes: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    dataUri: async () => "data:image/png;base64,iVBORw==",
    ...over,
  };
}

const created = { code: 0, data: { task_id: TASK_ID } };

function taskReply(data: Record<string, unknown>): Reply {
  return { json: { code: 0, data: { task_id: TASK_ID, type: "text_to_model", created_at: "2026-04-28T12:00:00Z", ...data } } };
}

const successTask = {
  status: "success",
  progress: 100,
  output: {
    model_url: "https://cdn.tripo3d.ai/output/model_pbr.glb",
    rendered_image_url: "https://cdn.tripo3d.ai/output/preview.png",
  },
  completed_at: "2026-04-28T12:01:30Z",
};

describe("tripoVendor identity", () => {
  it("declares vendor, modality and default key env", () => {
    expect(tripoVendor.vendor).toBe("tripo");
    expect(tripoVendor.modalities).toEqual(["model3d"]);
    expect(tripoVendor.defaultApiKeyEnv).toBe("TRIPO_API_KEY");
    const p = provider();
    expect(p.name).toBe("tripo-test");
    expect(p.vendor).toBe("tripo");
    expect(p.maxPerJob).toBeUndefined();
    expect(p.cancel).toBeUndefined(); // no cancel endpoint is documented
  });
});

describe("start: text-to-model", () => {
  it("posts the documented body to /v3/generation/text-to-model with a Bearer key", async () => {
    const { ctx, calls } = makeCtx([{ json: created }]);
    const handle = await provider().start(
      req({ mode: "text", prompt: "A cat wearing a spacesuit", negativePrompt: "blurry, low quality", seed: 7, texture: true }),
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://openapi.tripo3d.ai/v3/generation/text-to-model");
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({
      model: "v3.1-20260211",
      prompt: "A cat wearing a spacesuit",
      negative_prompt: "blurry, low quality",
      model_seed: 7,
      texture: true,
    });
    expect(handle.id).toBe(TASK_ID);
    expect(handle.done).toBeUndefined();
    expect(JSON.parse(JSON.stringify(handle))).toEqual(handle); // journal-safe
    expect(JSON.stringify(handle)).not.toContain(KEY);
  });

  it("defaults to text mode without inputs and uses the node/provider model", async () => {
    const a = makeCtx([{ json: created }]);
    await provider({ model: "v3.0-20250812" }).start(req({ prompt: "a robot" }), a.ctx);
    expect((a.calls[0]!.body as Record<string, unknown>)["model"]).toBe("v3.0-20250812");
    const b = makeCtx([{ json: created }]);
    await provider({ model: "v3.0-20250812" }).start(req({ prompt: "a robot", model: "P2-20260801" }), b.ctx);
    expect((b.calls[0]!.body as Record<string, unknown>)["model"]).toBe("P2-20260801");
  });

  it("texture=false also sends pbr=false (pbr would force texture on)", async () => {
    const { ctx, calls } = makeCtx([{ json: created }]);
    await provider().start(req({ prompt: "a chair", texture: false }), ctx);
    expect(calls[0]!.body).toMatchObject({ texture: false, pbr: false });
  });

  it("maps quality to texture_quality, face_limit, and the fast texture version", async () => {
    const run = async (quality: string) => {
      const { ctx, calls } = makeCtx([{ json: created }]);
      await provider().start(req({ prompt: "a chair", quality }), ctx);
      return calls[0]!.body as Record<string, unknown>;
    };
    expect(await run("detailed")).toMatchObject({ texture_quality: "detailed" });
    expect(await run("Extreme")).toMatchObject({ texture_quality: "extreme" });
    expect(await run("fast")).toMatchObject({ texture_quality: "fast", texture_version: "v3.5-20260815" });
    expect(await run("50000")).toMatchObject({ face_limit: 50000 });
    const { ctx } = makeCtx([]);
    await expect(provider().start(req({ prompt: "a chair", quality: "ultra" }), ctx)).rejects.toThrow(/unsupported quality "ultra"/);
  });

  it("requires a prompt and enforces documented length limits", async () => {
    const { ctx } = makeCtx([]);
    await expect(provider().start(req({ mode: "text" }), ctx)).rejects.toThrow(/needs a prompt/);
    await expect(provider().start(req({ prompt: "x".repeat(1025) }), ctx)).rejects.toThrow(/limit is 1024/);
    await expect(provider().start(req({ prompt: "ok", negativePrompt: "y".repeat(256) }), ctx)).rejects.toThrow(/limit is 255/);
  });

  it("merges params last (over generated fields) and provider-level option params before them", async () => {
    const { ctx, calls } = makeCtx([{ json: created }]);
    await provider({ options: { params: { auto_size: true, face_limit: 1000 } } }).start(
      req({ prompt: "a helmet", params: { face_limit: 80000, geometry_quality: "detailed", model: "v3.0-20250812" } }),
      ctx,
    );
    expect(calls[0]!.body).toMatchObject({
      prompt: "a helmet",
      auto_size: true,
      face_limit: 80000,
      geometry_quality: "detailed",
      model: "v3.0-20250812",
    });
  });
});

describe("start: image-to-model", () => {
  it("passes a remote URL straight through (no upload)", async () => {
    const { ctx, calls } = makeCtx([{ json: created }]);
    const handle = await provider().start(
      req({ mode: "image", texture: true, inputs: [input({ ref: "web", url: "https://example.com/image.png" })] }),
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openapi.tripo3d.ai/v3/generation/image-to-model");
    expect(calls[0]!.body).toEqual({ model: "v3.1-20260211", texture: true, input: "https://example.com/image.png" });
    expect(handle).toMatchObject({ id: TASK_ID, endpoint: "image-to-model" });
  });

  it("uploads local bytes via POST /v3/files and uses the returned file_token", async () => {
    const { ctx, calls } = makeCtx([{ json: { code: 0, data: { file_token: "file_abc123" } } }, { json: created }]);
    await provider().start(req({ inputs: [input({ ref: "photo.png", mimeType: "image/png" })] }), ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://openapi.tripo3d.ai/v3/files");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined(); // multipart boundary is set by fetch
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("input.png");
    expect(file.size).toBe(4);
    expect(calls[1]!.url).toBe("https://openapi.tripo3d.ai/v3/generation/image-to-model");
    expect(calls[1]!.body).toMatchObject({ input: "file_abc123" });
  });

  it("rejects unsupported image types and wrong input counts; drops prompt/negativePrompt with a warning", async () => {
    const a = makeCtx([]);
    await expect(
      provider().start(req({ mode: "image", inputs: [input({ ref: "x.gif", mimeType: "image/gif" })] }), a.ctx),
    ).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(provider().start(req({ mode: "image" }), a.ctx)).rejects.toThrow(/exactly one input/);

    const b = makeCtx([{ json: created }]);
    await provider().start(
      req({ prompt: "ignored", negativePrompt: "ignored", inputs: [input({ ref: "u", url: "https://example.com/a.png" })] }),
      b.ctx,
    );
    expect(b.warn).toHaveBeenCalledTimes(2);
    expect(b.calls[0]!.body).not.toHaveProperty("prompt");
    expect(b.calls[0]!.body).not.toHaveProperty("negative_prompt");
  });
});

describe("start: multiview-to-model", () => {
  it("sends view-key objects in front,left,back order, mixing URLs and uploads", async () => {
    const { ctx, calls } = makeCtx([{ json: { code: 0, data: { file_token: "file_left" } } }, { json: created }]);
    const handle = await provider().start(
      req({
        mode: "multiview",
        texture: false,
        inputs: [
          input({ ref: "front", url: "https://example.com/front.png" }),
          input({ ref: "left.png" }),
          input({ ref: "back", url: "https://example.com/back.png" }),
        ],
      }),
      ctx,
    );
    expect(calls[0]!.url).toBe("https://openapi.tripo3d.ai/v3/files");
    expect(calls[1]!.url).toBe("https://openapi.tripo3d.ai/v3/generation/multiview-to-model");
    expect(calls[1]!.body).toEqual({
      model: "v3.1-20260211",
      texture: false,
      pbr: false,
      inputs: [{ front: "https://example.com/front.png" }, { left: "file_left" }, { back: "https://example.com/back.png" }],
    });
    expect(handle).toMatchObject({ id: TASK_ID, endpoint: "multiview-to-model" });
  });

  it("is inferred from several inputs and needs 2-4 images", async () => {
    const urls = ["a", "b", "c", "d", "e"].map((n) => input({ ref: n, url: `https://example.com/${n}.png` }));
    const ok = makeCtx([{ json: created }]);
    await provider().start(req({ inputs: urls.slice(0, 4) }), ok.ctx);
    expect(ok.calls[0]!.url).toMatch(/multiview-to-model$/);
    expect((ok.calls[0]!.body as { inputs: unknown[] }).inputs).toHaveLength(4);
    const bad = makeCtx([]);
    await expect(provider().start(req({ mode: "multiview", inputs: urls.slice(0, 1) }), bad.ctx)).rejects.toThrow(/2-4 images/);
    await expect(provider().start(req({ mode: "multiview", inputs: urls }), bad.ctx)).rejects.toThrow(/2-4 images/);
  });
});

describe("start: format handling", () => {
  it("glb (default) needs no conversion", async () => {
    const { ctx } = makeCtx([{ json: created }, { json: created }]);
    expect(await provider().start(req({ prompt: "x", format: "glb" }), ctx)).toMatchObject({ outputFormat: "glb" });
    const h = await provider().start(req({ prompt: "x" }), ctx);
    expect(h).toMatchObject({ outputFormat: "glb" });
    expect(h).not.toHaveProperty("convertTo");
  });

  it("records the conversion target for other documented formats", async () => {
    for (const [f, target] of [["gltf", "GLTF"], ["fbx", "FBX"], ["obj", "OBJ"], ["usdz", "USDZ"], ["stl", "STL"]] as const) {
      const { ctx } = makeCtx([{ json: created }]);
      expect(await provider().start(req({ prompt: "x", format: f }), ctx)).toMatchObject({ outputFormat: f, convertTo: target });
    }
  });

  it("throws a clear error naming supported formats for anything else", async () => {
    const { ctx, calls } = makeCtx([]);
    await expect(provider().start(req({ prompt: "x", format: "dae" }), ctx)).rejects.toThrow(/unsupported format "dae".*glb, gltf, fbx, usdz, obj, stl, 3mf/);
    expect(calls).toHaveLength(0); // rejected before any request is paid for
  });

  it("quad meshes are FBX natively and cannot be delivered as GLB", async () => {
    const a = makeCtx([{ json: created }]);
    expect(await provider().start(req({ prompt: "x", format: "fbx", params: { quad: true } }), a.ctx)).toMatchObject({
      outputFormat: "fbx",
    });
    expect(a.calls[0]!.body).toMatchObject({ quad: true });
    const b = makeCtx([]);
    await expect(provider().start(req({ prompt: "x", format: "glb", params: { quad: true } }), b.ctx)).rejects.toThrow(/quad.*FBX/);
  });
});

describe("poll: status mapping", () => {
  const cases: Array<[Record<string, unknown>, string, number | undefined]> = [
    [{ status: "queued", progress: 0 }, "queued", 0],
    [{ status: "running", progress: 50 }, "running", 50],
    [{ status: "success", progress: 100 }, "done", 100],
    [{ status: "failed" }, "failed", undefined],
    [{ status: "cancelled" }, "canceled", undefined],
    [{ status: "banned" }, "failed", undefined],
    [{ status: "expired" }, "failed", undefined],
    [{ status: "unknown" }, "running", undefined], // docs: not success, not failure
  ];
  for (const [data, state, progress] of cases) {
    it(`${String(data["status"])} -> ${state}`, async () => {
      const { ctx, calls } = makeCtx([taskReply(data)]);
      const s = await provider().poll!({ id: TASK_ID }, ctx);
      expect(s.state).toBe(state);
      expect(s.progress).toBe(progress);
      expect(calls[0]!.method).toBe("GET");
      expect(calls[0]!.url).toBe(`https://openapi.tripo3d.ai/v3/tasks/${TASK_ID}`);
      expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    });
  }

  it("surfaces the vendor error text and code on failure", async () => {
    const { ctx } = makeCtx([taskReply({ status: "failed", error_code: 2008, error_message: "The input is rejected due to violation of content policy" })]);
    const s = await provider().poll!({ id: TASK_ID }, ctx);
    expect(s).toEqual({ state: "failed", error: "The input is rejected due to violation of content policy (error_code 2008)" });
  });

  it("falls back to a generic failure message", async () => {
    const { ctx } = makeCtx([taskReply({ status: "failed" })]);
    expect((await provider().poll!({ id: TASK_ID }, ctx)).error).toMatch(/status "failed"/);
  });

  it("reports credits_consumed as costUSD at $0.01 per credit, plus a basic convert when converting", async () => {
    const a = makeCtx([taskReply({ ...successTask, credits_consumed: 20 })]);
    expect((await provider().poll!({ id: TASK_ID }, a.ctx)).costUSD).toBeCloseTo(0.2, 6);
    const b = makeCtx([taskReply({ ...successTask, credits_consumed: 27.5 })]);
    expect((await provider().poll!({ id: TASK_ID, convertTo: "OBJ" } as JobHandle, b.ctx)).costUSD).toBeCloseTo(0.325, 6);
    const c = makeCtx([taskReply(successTask)]);
    expect((await provider().poll!({ id: TASK_ID }, c.ctx)).costUSD).toBeUndefined();
  });

  it("treats 429 and 5xx on the status call as still running; other errors throw", async () => {
    const a = makeCtx([{ status: 503, text: "upstream down" }, { status: 429, json: { code: 1007, message: "Rate limit exceeded" } }]);
    expect((await provider().poll!({ id: TASK_ID }, a.ctx)).state).toBe("running");
    expect((await provider().poll!({ id: TASK_ID }, a.ctx)).state).toBe("running");
    const b = makeCtx([{ status: 404, json: { code: 2001, message: "The task is not found" } }]);
    await expect(provider().poll!({ id: TASK_ID }, b.ctx)).rejects.toThrow(/\[2001\] The task is not found/);
  });
});

describe("fetch: immediate download", () => {
  it("re-queries the task and hands the fresh model_url to saveOutput right away", async () => {
    const { ctx, events, saved } = makeCtx([taskReply({ ...successTask, credits_consumed: 20 })]);
    const handle = { id: TASK_ID, endpoint: "text-to-model", model: "v3.1-20260211", outputFormat: "glb" };
    const [art] = await provider().fetch!(handle, ctx);
    expect(events).toEqual([`GET /v3/tasks/${TASK_ID}`, "saveOutput https://cdn.tripo3d.ai/output/model_pbr.glb"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ url: "https://cdn.tripo3d.ai/output/model_pbr.glb", mimeType: "model/gltf-binary" });
    expect("headers" in saved[0]!).toBe(false); // signed URL: never send the API key to the CDN
    expect(art!.meta).toMatchObject({
      costUSD: 0.2,
      tripo: { taskId: TASK_ID, type: "text_to_model", model: "v3.1-20260211", format: "glb", creditsConsumed: 20, convertTaskId: null },
    });
    expect(JSON.parse(JSON.stringify(art!.meta))).toEqual(art!.meta);
  });

  it("refuses to fetch an unfinished task or one without a model_url", async () => {
    const handle = { id: TASK_ID, outputFormat: "glb" };
    const a = makeCtx([taskReply({ status: "running", progress: 40 })]);
    await expect(provider().fetch!(handle, a.ctx)).rejects.toThrow(/not finished/);
    const b = makeCtx([taskReply({ status: "success", output: {} })]);
    await expect(provider().fetch!(handle, b.ctx)).rejects.toThrow(/no output.model_url/);
    expect(b.saved).toHaveLength(0);
  });

  it("falls back to the compatibility alias pbr_model", async () => {
    const { ctx, saved } = makeCtx([taskReply({ status: "success", output: { pbr_model: "https://cdn.tripo3d.ai/o/pbr.glb" } })]);
    await provider().fetch!({ id: TASK_ID, outputFormat: "glb" }, ctx);
    expect(saved[0]).toMatchObject({ url: "https://cdn.tripo3d.ai/o/pbr.glb" });
  });

  it("saves the preview only when asked, linked as meta.thumbnail", async () => {
    const off = makeCtx([taskReply(successTask)]);
    await provider().fetch!({ id: TASK_ID, outputFormat: "glb" }, off.ctx);
    expect(off.saved).toHaveLength(1);

    const on = makeCtx([taskReply(successTask)]);
    const arts = await provider({ options: { savePreview: true } }).fetch!({ id: TASK_ID, outputFormat: "glb" }, on.ctx);
    expect(arts).toHaveLength(1); // the model stays the only artifact
    expect(on.saved).toHaveLength(2);
    expect(on.saved[1]).toMatchObject({ url: "https://cdn.tripo3d.ai/output/preview.png" });
    expect(arts[0]!.meta).toMatchObject({ thumbnail: ".flowgraph/artifacts/n/job-1.bin" });
  });
});

describe("fetch: conversion to another format", () => {
  it("runs POST /v3/models/convert on the task id, waits, then downloads the converted URL", async () => {
    const convertId = "c0nvert-task";
    const { ctx, calls, events, saved } = makeCtx([
      taskReply({ ...successTask, credits_consumed: 20 }),
      { json: { code: 0, data: { task_id: convertId } } },
      { json: { code: 0, data: { task_id: convertId, type: "convert_model", status: "running", progress: 30 } } },
      {
        json: {
          code: 0,
          data: {
            task_id: convertId,
            type: "convert_model",
            status: "success",
            progress: 100,
            credits_consumed: 5,
            output: { model_url: "https://cdn.tripo3d.ai/output/converted-model.obj", rendered_image_url: "https://cdn.tripo3d.ai/output/preview.png" },
          },
        },
      },
    ]);
    const handle = { id: TASK_ID, endpoint: "text-to-model", model: "v3.1-20260211", outputFormat: "obj", convertTo: "OBJ" };
    const [art] = await provider({ options: { convertPollIntervalMs: 0 } }).fetch!(handle, ctx);
    expect(calls[1]!.url).toBe("https://openapi.tripo3d.ai/v3/models/convert");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body).toEqual({ input: TASK_ID, format: "OBJ" });
    expect(events.at(-1)).toBe("saveOutput https://cdn.tripo3d.ai/output/converted-model.obj");
    expect(events.filter((e) => e.startsWith("saveOutput"))).toHaveLength(1);
    expect(saved[0]).toMatchObject({ mimeType: "model/obj" });
    expect(art!.meta).toMatchObject({ costUSD: 0.25, tripo: { creditsConsumed: 25, convertTaskId: convertId, format: "obj" } });
  });

  it("forwards options.convertParams and surfaces a failed conversion", async () => {
    const { ctx, calls } = makeCtx([
      taskReply(successTask),
      { json: { code: 0, data: { task_id: "cv" } } },
      { json: { code: 0, data: { task_id: "cv", status: "failed", error_code: 2018, error_message: "The model is too complex to remesh" } } },
    ]);
    await expect(
      provider({ options: { convertParams: { texture_size: 2048, texture_format: "PNG" } } }).fetch!(
        { id: TASK_ID, outputFormat: "fbx", convertTo: "FBX" },
        ctx,
      ),
    ).rejects.toThrow(/convert to FBX.*failed: The model is too complex to remesh \(error_code 2018\)/);
    expect(calls[1]!.body).toEqual({ texture_size: 2048, texture_format: "PNG", input: TASK_ID, format: "FBX" });
  });

  it("gives up with a clear error when the conversion never finishes", async () => {
    const { ctx } = makeCtx([
      taskReply(successTask),
      { json: { code: 0, data: { task_id: "cv" } } },
      { json: { code: 0, data: { task_id: "cv", status: "running" } } },
    ]);
    await expect(
      provider({ options: { convertPollIntervalMs: 10, convertTimeoutMs: 5 } }).fetch!(
        { id: TASK_ID, outputFormat: "stl", convertTo: "STL" },
        ctx,
      ),
    ).rejects.toThrow(/not finished after 5 ms/);
  });
});

describe("credentials", () => {
  it("fails clearly when no key is set, naming the env vars, before any request", async () => {
    const { ctx, calls } = makeCtx([], {});
    await expect(provider().start(req({ prompt: "x" }), ctx)).rejects.toThrow(/no API key.*TRIPO_API_KEY/);
    await expect(provider().poll!({ id: TASK_ID }, ctx)).rejects.toThrow(/no API key/);
    await expect(provider().fetch!({ id: TASK_ID }, ctx)).rejects.toThrow(/no API key/);
    expect(calls).toHaveLength(0);
  });

  it("honors apiKeyEnv and resolves the key on every call", async () => {
    const secrets: Record<string, string> = { MY_TRIPO: "first" };
    const { ctx, calls } = makeCtx([{ json: created }, taskReply({ status: "running" })], secrets);
    const p = provider({ apiKeyEnv: "MY_TRIPO" });
    await p.start(req({ prompt: "x" }), ctx);
    secrets["MY_TRIPO"] = "rotated";
    await p.poll!({ id: TASK_ID }, ctx);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer first");
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer rotated");
  });

  it("falls back to TRIPO_API_KEY when apiKeyEnv is unset in the secrets", async () => {
    const { ctx, calls } = makeCtx([{ json: created }], { TRIPO_API_KEY: "fallback" });
    await provider({ apiKeyEnv: "NOT_SET" }).start(req({ prompt: "x" }), ctx);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer fallback");
  });
});

describe("API errors", () => {
  it("surfaces the documented insufficient-credits error (HTTP 403, code 2010)", async () => {
    const body = {
      code: 2010,
      status: "error",
      message: "You don't have enough credit to create this task",
      suggestion: "Please purchase more credit",
      request_id: "req_abc123",
    };
    const { ctx } = makeCtx([{ status: 403, json: body }]);
    const err = await provider()
      .start(req({ prompt: "x" }), ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect((err as VendorHttpError).status).toBe(403);
    expect((err as Error).message).toContain("[2010] You don't have enough credit to create this task");
    expect((err as Error).message).toContain("Please purchase more credit");
    expect((err as Error).message).toContain("req_abc123");
    expect((err as Error).message).not.toContain(KEY);
  });

  it("surfaces auth failures (HTTP 401, code 2)", async () => {
    const { ctx } = makeCtx([{ status: 401, json: { code: 2, status: "error", message: "Authentication required", suggestion: "Check if your credentials is valid" } }]);
    await expect(provider().start(req({ prompt: "x" }), ctx)).rejects.toThrow(/HTTP 401: \[2\] Authentication required/);
  });

  it("surfaces the concurrency limit (HTTP 429, code 2000)", async () => {
    const { ctx } = makeCtx([{ status: 429, json: { code: 2000, message: "You have exceeded the limit of generation", suggestion: "Try again later." } }]);
    await expect(provider().start(req({ prompt: "x" }), ctx)).rejects.toThrow(/HTTP 429: \[2000\] You have exceeded the limit of generation/);
  });

  it("keeps non-JSON error bodies and handles a non-zero code inside a 200", async () => {
    const a = makeCtx([{ status: 502, text: "<html>Bad Gateway</html>" }]);
    await expect(provider().start(req({ prompt: "x" }), a.ctx)).rejects.toThrow(/HTTP 502: <html>Bad Gateway/);
    const b = makeCtx([{ json: { code: 1004, message: "One or more of your parameter is invalid" } }]);
    await expect(provider().start(req({ prompt: "x" }), b.ctx)).rejects.toThrow(/\[1004\] One or more of your parameter is invalid/);
  });

  it("fails when task creation returns no task_id", async () => {
    const { ctx } = makeCtx([{ json: { code: 0, data: {} } }]);
    await expect(provider().start(req({ prompt: "x" }), ctx)).rejects.toThrow(/no task_id/);
  });
});

describe("baseUrl override", () => {
  it("is used for generation, upload, polling, conversion and tolerates a trailing slash", async () => {
    const { ctx, calls } = makeCtx([
      { json: { code: 0, data: { file_token: "file_abc123" } } },
      { json: created },
      taskReply(successTask),
      { json: { code: 0, data: { task_id: "cv" } } },
      taskReply({ status: "success", output: { model_url: "https://cdn.example/m.stl" } }),
    ]);
    const p = provider({ baseUrl: "https://proxy.example.com/tripo/v3/" , options: { convertPollIntervalMs: 0 } });
    const handle = await p.start(req({ inputs: [input({ ref: "a.png" })], format: "stl" }), ctx);
    await p.fetch!(handle, ctx);
    expect(calls.map((c) => c.url)).toEqual([
      "https://proxy.example.com/tripo/v3/files",
      "https://proxy.example.com/tripo/v3/generation/image-to-model",
      `https://proxy.example.com/tripo/v3/tasks/${TASK_ID}`,
      "https://proxy.example.com/tripo/v3/models/convert",
      "https://proxy.example.com/tripo/v3/tasks/cv",
    ]);
  });
});

describe("estimateCostUSD (public price list, 1 credit = $0.01; H series only)", () => {
  const est = (r: Partial<MediaRequest>, options?: Record<string, unknown>) =>
    provider(options ? { options } : {}).estimateCostUSD!(req(r));

  it("prices text 10/20 credits and image or multiview 20/30 credits without/with texture", () => {
    expect(est({ mode: "text", prompt: "x", texture: false })).toBeCloseTo(0.1, 6);
    expect(est({ mode: "text", prompt: "x" })).toBeCloseTo(0.2, 6);
    expect(est({ mode: "image", inputs: [input({ ref: "a" })], texture: false })).toBeCloseTo(0.2, 6);
    expect(est({ mode: "image", inputs: [input({ ref: "a" })] })).toBeCloseTo(0.3, 6);
    expect(est({ mode: "multiview", inputs: [input({ ref: "a" }), input({ ref: "b" })] })).toBeCloseTo(0.3, 6);
  });

  it("adds HD/8K texture, HD geometry, quad, low-poly, parts and basic conversion add-ons", () => {
    expect(est({ prompt: "x", quality: "detailed" })).toBeCloseTo(0.3, 6);
    expect(est({ prompt: "x", quality: "extreme" })).toBeCloseTo(0.4, 6);
    expect(est({ prompt: "x", quality: "fast" })).toBeCloseTo(0.2, 6); // same as standard
    expect(est({ prompt: "x", params: { geometry_quality: "detailed" } })).toBeCloseTo(0.4, 6);
    expect(est({ prompt: "x", format: "fbx", params: { quad: true } })).toBeCloseTo(0.25, 6);
    expect(est({ prompt: "x", params: { smart_low_poly: true } })).toBeCloseTo(0.3, 6);
    expect(est({ prompt: "x", texture: false, params: { generate_parts: true } })).toBeCloseTo(0.3, 6);
    expect(est({ prompt: "x", format: "obj" })).toBeCloseTo(0.25, 6);
  });

  it("is undefined for P-series models and for requests it cannot interpret", () => {
    expect(est({ prompt: "x", model: "P2-20260801" })).toBeUndefined();
    expect(provider({ model: "P1-20260311" }).estimateCostUSD!(req({ prompt: "x" }))).toBeUndefined();
    expect(est({ prompt: "x", quality: "bogus" })).toBeUndefined();
    expect(est({ prompt: "x", format: "dae" })).toBeUndefined();
  });
});
