/**
 * Offline tests for the Meshy adapter. No network: `ctx.fetch` is a stub that
 * replays queued Response objects and records every call.
 *
 * Fixtures are modelled on examples printed in the official docs (read 2026-11-05):
 *   - create response `{ "result": "018a210d-..." }`:  https://docs.meshy.ai/api/text-to-3d.md
 *   - SUCCEEDED text-to-3d-preview task object:         https://docs.meshy.ai/api/text-to-3d.md
 *   - SUCCEEDED image-to-3d / multi-image task objects:  https://docs.meshy.ai/api/image-to-3d.md,
 *                                                        https://docs.meshy.ai/api/multi-image-to-3d.md
 *   - 400 body `{ "message": ... }`, FAILED task_error:  https://docs.meshy.ai/api/errors.md
 *   - 409 DELETE body:                                   https://docs.meshy.ai/api/text-to-3d.md
 * They are NOT recordings of live calls.
 */

import { describe, expect, it } from "vitest";
import type { JobHandle, MediaCallContext, MediaInput, MediaRequest, MediaOutput } from "@flowgraph/core";
import { meshyVendor } from "./meshy.js";

const TASK_ID = "018a210d-8ba4-705c-b111-1f1776f7f578";
const REFINE_ID = "018a210d-8ba4-705c-b111-aaaaaaaaaaaa";
const KEY = "msy_sOmEbOgUsApIkEyFoReXaMpLe1234567890";
const BASE = "https://api.meshy.ai";
const A = "https://assets.meshy.ai/***/tasks";

/** model_urls block as printed in the docs' Text to 3D task example. */
const modelUrls = (id: string) => ({
  glb: `${A}/${id}/output/model.glb?Expires=***`,
  fbx: `${A}/${id}/output/model.fbx?Expires=***`,
  obj: `${A}/${id}/output/model.obj?Expires=***`,
  mtl: `${A}/${id}/output/model.mtl?Expires=***`,
  usdz: `${A}/${id}/output/model.usdz?Expires=***`,
  stl: `${A}/${id}/output/model.stl?Expires=***`,
});

const succeeded = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text-to-3d-preview",
  model_urls: modelUrls(id),
  thumbnail_url: `${A}/${id}/output/preview.png?Expires=***`,
  progress: 100,
  started_at: 1692771667037,
  created_at: 1692771650657,
  finished_at: 1692771669037,
  status: "SUCCEEDED",
  preceding_tasks: 0,
  task_error: null,
  consumed_credits: 20,
  ...extra,
});

const running = (id: string, progress: number, status = "IN_PROGRESS") => ({
  id,
  progress,
  status,
  task_error: null,
  created_at: 1692771650657,
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  /** Throw this instead of returning a response (network failure). */
  reject?: unknown;
}

function makeCtx(replies: Reply[], opts: { secrets?: Record<string, string>; signal?: AbortSignal } = {}) {
  const calls: Call[] = [];
  const saved: MediaOutput[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const queue = [...replies];
  const secrets = opts.secrets ?? { MESHY_API_KEY: KEY };
  const fetchStub = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    const r = queue.shift();
    if (!r) throw new Error(`unexpected fetch #${calls.length}: ${init?.method ?? "GET"} ${String(input)}`);
    if (r.reject !== undefined) throw r.reject;
    const status = r.status ?? 200;
    const text = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    return new Response(text, { status });
  }) as typeof fetch;
  const ctx: MediaCallContext = {
    secrets: { get: async (n) => secrets[n], has: (n) => n in secrets },
    ...(opts.signal ? { signal: opts.signal } : {}),
    logger: {
      debug: () => {},
      info: (m) => void logs.push(m),
      warn: (m) => void warnings.push(m),
      error: () => {},
    },
    fetch: fetchStub,
    saveOutput: async (out) => {
      saved.push(out);
      return { kind: "artifact", path: "out/model.bin", mimeType: ("mimeType" in out && out.mimeType) || "application/octet-stream", sizeBytes: 1 };
    },
  };
  return { ctx, calls, saved, warnings, logs, remaining: () => queue.length };
}

function input(over: Partial<MediaInput> & { ref: string }): MediaInput {
  return {
    mimeType: "image/png",
    identity: over.ref,
    bytes: async () => new Uint8Array([1, 2, 3]),
    dataUri: async () => "data:image/png;base64,AQID",
    ...over,
  };
}

const req = (over: Partial<MediaRequest> = {}): MediaRequest => ({
  modality: "model3d",
  inputs: [],
  count: 1,
  params: {},
  ...over,
});

const provider = (opts: Partial<Parameters<typeof meshyVendor.create>[0]> = {}) => meshyVendor.create({ name: "meshy", ...opts });

describe("meshy vendor", () => {
  it("declares the vendor contract", () => {
    expect(meshyVendor.vendor).toBe("meshy");
    expect(meshyVendor.modalities).toEqual(["model3d"]);
    expect(meshyVendor.defaultApiKeyEnv).toBe("MESHY_API_KEY");
    const p = provider({ name: "m3d" });
    expect(p.name).toBe("m3d");
    expect(p.vendor).toBe("meshy");
    expect(p.estimateCostUSD).toBeUndefined(); // no documented price per credit
    expect(p.pollIntervalMs).toBe(5000);
    expect(provider({ options: { pollIntervalMs: 250 } }).pollIntervalMs).toBe(250);
  });

  describe("text to 3D, preview only", () => {
    it("creates a preview task (v2) and downloads the glb immediately", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }, { json: succeeded(TASK_ID) }, { json: succeeded(TASK_ID) }]);
      const p = provider();
      const handle = await p.start(req({ prompt: "a monster mask", texture: false, seed: 7, negativePrompt: "blurry" }), t.ctx);

      expect(t.calls[0]).toMatchObject({ url: `${BASE}/openapi/v2/text-to-3d`, method: "POST" });
      expect(t.calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
      expect(t.calls[0]!.body).toEqual({
        mode: "preview",
        prompt: "a monster mask",
        negative_prompt: "blurry",
        seed: 7,
        target_formats: ["glb"],
      });
      expect(handle).toMatchObject({ id: TASK_ID, kind: "text", stage: "preview", previewId: TASK_ID, format: "glb" });
      expect(handle["refine"]).toBeUndefined();
      expect(JSON.stringify(handle)).not.toContain(KEY);

      const st = await p.poll!(handle, t.ctx);
      expect(st).toEqual({ state: "done", progress: 100 });
      expect(st.handle).toBeUndefined();
      expect(t.calls[1]).toMatchObject({ url: `${BASE}/openapi/v2/text-to-3d/${TASK_ID}`, method: "GET" });

      const arts = await p.fetch!(handle, t.ctx);
      expect(arts).toHaveLength(1);
      expect(t.saved).toEqual([{ url: `${A}/${TASK_ID}/output/model.glb?Expires=***`, mimeType: "model/gltf-binary", ext: "glb" }]);
      // the signed download carries no Authorization (we pass only {url, mimeType, ext})
      expect(JSON.stringify(t.saved)).not.toContain(KEY);
      expect(t.remaining()).toBe(0);
    });

    it("requires a prompt in text mode", async () => {
      const t = makeCtx([]);
      await expect(provider().start(req({ prompt: "  " }), t.ctx)).rejects.toThrow(/needs a prompt/);
      expect(t.calls).toHaveLength(0);
    });
  });

  describe("text to 3D, preview then refine as one job", () => {
    it("advances the state machine across polls and journals the refine handle", async () => {
      const t = makeCtx([
        { status: 202, json: { result: TASK_ID } }, // start: preview
        { json: running(TASK_ID, 0, "PENDING") }, // poll 1
        { json: running(TASK_ID, 40) }, // poll 2
        { json: succeeded(TASK_ID) }, // poll 3 -> creates refine
        { status: 202, json: { result: REFINE_ID } },
        { json: running(REFINE_ID, 50) }, // poll 4 (replacement handle)
        { json: succeeded(REFINE_ID, { type: "text-to-3d-refine", consumed_credits: 10 }) }, // poll 5
        { json: succeeded(REFINE_ID, { type: "text-to-3d-refine" }) }, // fetch
      ]);
      const p = provider({ model: "meshy-6" });
      const h0 = await p.start(req({ prompt: "a monster mask", quality: "4k", params: { enable_pbr: true, geometry_resolution: "2k" } }), t.ctx);

      // preview body: model mapped, preview-only params routed there, no refine-only params
      expect(t.calls[0]!.body).toEqual({ mode: "preview", prompt: "a monster mask", ai_model: "meshy-6", geometry_resolution: "2k" });
      expect(h0).toMatchObject({ stage: "preview", previewId: TASK_ID });
      expect(h0["refine"]).toEqual({ target_formats: ["glb"], texture_resolution: "4k", enable_pbr: true });
      expect(h0["refineId"]).toBeUndefined();

      const s1 = await p.poll!(h0, t.ctx);
      expect(s1).toEqual({ state: "queued", progress: 0 });
      const s2 = await p.poll!(h0, t.ctx);
      expect(s2).toEqual({ state: "running", progress: 20 }); // preview = first half
      expect(s2.handle).toBeUndefined();

      const s3 = await p.poll!(h0, t.ctx);
      expect(s3.state).toBe("running");
      expect(s3.progress).toBe(50);
      expect(s3.handle).toMatchObject({ id: REFINE_ID, stage: "refine", previewId: TASK_ID, refineId: REFINE_ID, kind: "text", format: "glb" });
      expect(t.calls[4]).toMatchObject({ url: `${BASE}/openapi/v2/text-to-3d`, method: "POST" });
      expect(t.calls[4]!.body).toEqual({
        mode: "refine",
        preview_task_id: TASK_ID,
        target_formats: ["glb"],
        texture_resolution: "4k",
        enable_pbr: true,
      });

      // The engine journals s3.handle and polls with it from here on: no second refine create.
      const h1 = s3.handle as JobHandle;
      const s4 = await p.poll!(h1, t.ctx);
      expect(s4).toEqual({ state: "running", progress: 75 });
      const s5 = await p.poll!(h1, t.ctx);
      expect(s5).toEqual({ state: "done", progress: 100 });
      expect(s5.handle).toBeUndefined();
      expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(2); // exactly one preview + one refine
      expect(t.calls[5]!.url).toBe(`${BASE}/openapi/v2/text-to-3d/${REFINE_ID}`);

      await p.fetch!(h1, t.ctx);
      expect(t.calls[7]!.url).toBe(`${BASE}/openapi/v2/text-to-3d/${REFINE_ID}`); // final stage, not the preview
      expect(t.saved[0]).toMatchObject({ url: `${A}/${REFINE_ID}/output/model.glb?Expires=***` });
      expect(t.remaining()).toBe(0);
    });

    it("re-polling a handle that already has a refineId never creates another refine", async () => {
      const t = makeCtx([{ json: succeeded(REFINE_ID) }]);
      const p = provider();
      // A stale handle (stage still "preview") that nevertheless carries refineId polls the refine task.
      const st = await p.poll!(
        { id: TASK_ID, kind: "text", stage: "preview", previewId: TASK_ID, refineId: REFINE_ID, format: "glb", refine: { target_formats: ["glb"] } },
        t.ctx,
      );
      expect(st.state).toBe("done");
      expect(t.calls[0]!.url).toBe(`${BASE}/openapi/v2/text-to-3d/${REFINE_ID}`);
      expect(t.calls.every((c) => c.method === "GET")).toBe(true);
    });

    it("routes params by stage and honours params.preview / params.refine", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      const h = await provider().start(
        req({
          prompt: "a robot",
          params: {
            topology: "quad",
            should_remesh: true,
            texture_prompt: "rusty metal",
            remove_lighting: false,
            moderation: true,
            auto_size: true,
            refine: { ai_model: "meshy-n1" },
            preview: { target_polycount: 5000 },
          },
        }),
        t.ctx,
      );
      expect(t.calls[0]!.body).toEqual({
        mode: "preview",
        prompt: "a robot",
        topology: "quad",
        should_remesh: true,
        moderation: true,
        target_polycount: 5000,
      });
      expect(h["refine"]).toEqual({
        target_formats: ["glb"],
        texture_prompt: "rusty metal",
        remove_lighting: false,
        moderation: true,
        auto_size: true,
        ai_model: "meshy-n1",
      });
    });

    it("enablePbr option turns on PBR maps for the refine stage", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      const h = await provider({ options: { enablePbr: true } }).start(req({ prompt: "x" }), t.ctx);
      expect(h["refine"]).toEqual({ target_formats: ["glb"], enable_pbr: true });
    });

    it("smart-topology models set model_type automatically", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      await provider({ model: "meshy-t2.5" }).start(req({ prompt: "x", texture: false }), t.ctx);
      expect(t.calls[0]!.body).toMatchObject({ ai_model: "meshy-t2.5", model_type: "smart-topology" });
    });

    it("surfaces a preview-stage failure with the vendor message", async () => {
      const t = makeCtx([
        {
          json: {
            id: TASK_ID,
            status: "FAILED",
            progress: 30,
            task_error: {
              type: "invalid_input",
              code: "image_too_complex",
              message: "The uploaded image is too complex for 3D generation.",
              doc_url: "https://docs.meshy.ai/en/api/errors#image-too-complex",
            },
          },
        },
      ]);
      const st = await provider().poll!({ id: TASK_ID, kind: "text", stage: "preview", previewId: TASK_ID, format: "glb", refine: {} }, t.ctx);
      expect(st.state).toBe("failed");
      expect(st.error).toBe("[image_too_complex] The uploaded image is too complex for 3D generation. (preview stage)");
    });

    it("surfaces a refine-stage failure and maps the progress into the second half", async () => {
      const t = makeCtx([
        { json: { id: REFINE_ID, status: "FAILED", progress: 20, task_error: { type: "server_error", message: "An internal error occurred. Please retry." } } },
      ]);
      const st = await provider().poll!(
        { id: REFINE_ID, kind: "text", stage: "refine", previewId: TASK_ID, refineId: REFINE_ID, format: "glb", refine: {} },
        t.ctx,
      );
      expect(st).toEqual({ state: "failed", progress: 60, error: "[server_error] An internal error occurred. Please retry. (refine stage)" });
    });

    it("a throttled refine create (429) is retried on the next poll; no handle change", async () => {
      const t = makeCtx([{ json: succeeded(TASK_ID) }, { status: 429, json: { message: "Rate limit exceeded" } }]);
      const st = await provider().poll!({ id: TASK_ID, kind: "text", stage: "preview", previewId: TASK_ID, format: "glb", refine: { target_formats: ["glb"] } }, t.ctx);
      expect(st).toEqual({ state: "running", progress: 50 });
      expect(st.handle).toBeUndefined();
    });

    it("a refine create that fails with 402 names the finished preview", async () => {
      const t = makeCtx([{ json: succeeded(TASK_ID) }, { status: 402, json: { message: "Insufficient credits" } }]);
      await expect(
        provider().poll!({ id: TASK_ID, kind: "text", stage: "preview", previewId: TASK_ID, format: "glb", refine: {} }, t.ctx),
      ).rejects.toThrow(new RegExp(`preview ${TASK_ID} succeeded but the refine task could not be created: meshy: HTTP 402: Insufficient credits`));
    });

    it("does not blindly retry a refine create that fails with 5xx (it may exist)", async () => {
      const t = makeCtx([{ json: succeeded(TASK_ID) }, { status: 502, text: "bad gateway" }]);
      await expect(
        provider().poll!({ id: TASK_ID, kind: "text", stage: "preview", previewId: TASK_ID, format: "glb", refine: {} }, t.ctx),
      ).rejects.toThrow(/may already exist.*not retried automatically/s);
    });
  });

  describe("image to 3D", () => {
    it("passes a remote URL straight through (v1 endpoint)", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      const h = await provider().start(
        req({ mode: "image", inputs: [input({ ref: "web", url: "https://example.com/photo.jpg" })], texture: true }),
        t.ctx,
      );
      expect(t.calls[0]).toMatchObject({ url: `${BASE}/openapi/v1/image-to-3d`, method: "POST" });
      expect(t.calls[0]!.body).toEqual({ image_url: "https://example.com/photo.jpg", should_texture: true, target_formats: ["glb"] });
      expect(h).toMatchObject({ id: TASK_ID, kind: "image", stage: "single" });
    });

    it("falls back to a data URI for local files; texture:false untextured; model, quality, PBR", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }, { status: 202, json: { result: TASK_ID } }]);
      await provider().start(req({ inputs: [input({ ref: "file", filePath: "/tmp/a.png" })], texture: false, model: "meshy-6-lite", quality: "4k" }), t.ctx);
      expect(t.calls[0]!.body).toEqual({
        image_url: "data:image/png;base64,AQID",
        should_texture: false,
        ai_model: "meshy-6-lite",
        target_formats: ["glb"],
      });
      // inferred mode: one input => image; textured => quality maps to texture_resolution, PBR from options
      await provider({ options: { enablePbr: true } }).start(req({ inputs: [input({ ref: "file" })], quality: "4k" }), t.ctx);
      expect(t.calls[1]!.body).toMatchObject({ should_texture: true, texture_resolution: "4k", enable_pbr: true });
    });

    it("needs exactly one input", async () => {
      const t = makeCtx([]);
      await expect(provider().start(req({ mode: "image", inputs: [] }), t.ctx)).rejects.toThrow(/exactly one input/);
      expect(t.calls).toHaveLength(0);
    });

    it("polls and fetches from the v1 task path", async () => {
      const t = makeCtx([{ json: succeeded(TASK_ID, { type: "image-to-3d", consumed_credits: 30 }) }, { json: succeeded(TASK_ID) }]);
      const p = provider();
      const h: JobHandle = { id: TASK_ID, kind: "image", stage: "single", format: "glb" };
      expect(await p.poll!(h, t.ctx)).toEqual({ state: "done", progress: 100 });
      await p.fetch!(h, t.ctx);
      expect(t.calls[0]!.url).toBe(`${BASE}/openapi/v1/image-to-3d/${TASK_ID}`);
      expect(t.saved).toHaveLength(1);
    });
  });

  describe("multi-image to 3D", () => {
    it("sends the inputs in order (URL or data URI each)", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      await provider().start(
        req({
          mode: "multiview",
          inputs: [
            input({ ref: "front", url: "https://example.com/front.png" }),
            input({ ref: "side", filePath: "/tmp/side.png", dataUri: async () => "data:image/png;base64,c2lkZQ==" }),
            input({ ref: "back", url: "https://example.com/back.png" }),
          ],
        }),
        t.ctx,
      );
      expect(t.calls[0]!.url).toBe(`${BASE}/openapi/v1/multi-image-to-3d`);
      expect(t.calls[0]!.body).toEqual({
        image_urls: ["https://example.com/front.png", "data:image/png;base64,c2lkZQ==", "https://example.com/back.png"],
        should_texture: true,
        target_formats: ["glb"],
      });
    });

    it("rejects 0 or more than 4 images before calling the API", async () => {
      const t = makeCtx([]);
      const five = Array.from({ length: 5 }, (_, i) => input({ ref: `i${i}`, url: `https://example.com/${i}.png` }));
      await expect(provider().start(req({ mode: "multiview", inputs: five }), t.ctx)).rejects.toThrow(/1-4 input images/);
      await expect(provider().start(req({ mode: "multiview", inputs: [] }), t.ctx)).rejects.toThrow(/1-4 input images/);
      expect(t.calls).toHaveLength(0);
    });
  });

  describe("status mapping", () => {
    const h: JobHandle = { id: TASK_ID, kind: "image", stage: "single", format: "glb" };

    it.each([
      ["PENDING", "queued"],
      ["IN_PROGRESS", "running"],
      ["SUCCEEDED", "done"],
      ["FAILED", "failed"],
      ["CANCELED", "canceled"],
    ] as const)("%s -> %s", async (status, state) => {
      const t = makeCtx([{ json: { id: TASK_ID, status, progress: 10, task_error: status === "FAILED" ? { message: "boom" } : null } }]);
      const st = await provider().poll!(h, t.ctx);
      expect(st.state).toBe(state);
      if (status === "FAILED") expect(st.error).toBe("boom");
    });

    it("an unknown status is treated as still running", async () => {
      const t = makeCtx([{ json: { id: TASK_ID, status: "REVIEWING" } }]);
      expect(await provider().poll!(h, t.ctx)).toEqual({ state: "running" });
      expect(t.warnings[0]).toMatch(/unknown task status/);
    });

    it.each([429, 500, 503])("a %s status response is not a task failure", async (code) => {
      const t = makeCtx([{ status: code, json: { message: "later" } }]);
      expect(await provider().poll!(h, t.ctx)).toEqual({ state: "running" });
    });

    it("a network error while polling is not a task failure", async () => {
      const t = makeCtx([{ reject: new TypeError("fetch failed") }]);
      expect(await provider().poll!(h, t.ctx)).toEqual({ state: "running" });
    });

    it("401/404 while polling are real errors", async () => {
      const t = makeCtx([{ status: 404, json: { message: "Task not found" } }, { status: 401, json: { message: "Unauthorized" } }]);
      await expect(provider().poll!(h, t.ctx)).rejects.toThrow(/HTTP 404: Task not found/);
      await expect(provider().poll!(h, t.ctx)).rejects.toThrow(/HTTP 401: Unauthorized \(check the Meshy API key/);
    });

    it("progress is clamped to 0..100", async () => {
      const t = makeCtx([{ json: { id: TASK_ID, status: "IN_PROGRESS", progress: 140 } }]);
      expect((await provider().poll!(h, t.ctx)).progress).toBe(100);
    });
  });

  describe("download and format selection", () => {
    it.each([
      ["glb", "model/gltf-binary"],
      ["fbx", "application/octet-stream"],
      ["obj", "model/obj"],
      ["usdz", "model/vnd.usdz+zip"],
      ["stl", "model/stl"],
    ])("format %s is requested via target_formats and downloaded from model_urls.%s", async (format, mime) => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }, { json: succeeded(TASK_ID) }]);
      const p = provider();
      const h = await p.start(req({ prompt: "x", texture: false, format: format === "glb" ? undefined : format.toUpperCase() }), t.ctx);
      expect(t.calls[0]!.body!["target_formats"]).toEqual([format]);
      await p.fetch!(h, t.ctx);
      expect(t.saved[0]).toEqual({ url: `${A}/${TASK_ID}/output/model.${format}?Expires=***`, mimeType: mime, ext: format });
    });

    it("accepts a leading dot in the format", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      const h = await provider().start(req({ prompt: "x", format: ".fbx" }), t.ctx);
      expect(h["format"]).toBe("fbx");
    });

    it("rejects an unsupported format before spending credits", async () => {
      const t = makeCtx([]);
      await expect(provider().start(req({ prompt: "x", format: "ply" }), t.ctx)).rejects.toThrow(/unsupported 3D format "ply".*glb, fbx, obj, usdz, stl, 3mf/);
      expect(t.calls).toHaveLength(0);
    });

    it("explains when the task did not produce the requested format", async () => {
      const t = makeCtx([{ json: succeeded(TASK_ID, { model_urls: { glb: `${A}/x/model.glb` } }) }]);
      await expect(provider().fetch!({ id: TASK_ID, kind: "text", stage: "preview", format: "fbx" }, t.ctx)).rejects.toThrow(
        /no "fbx" output \(available: glb\)/,
      );
    });

    it("refuses to download a task that has not succeeded", async () => {
      const t = makeCtx([{ json: running(TASK_ID, 50) }]);
      await expect(provider().fetch!({ id: TASK_ID, kind: "image", stage: "single", format: "glb" }, t.ctx)).rejects.toThrow(/not SUCCEEDED/);
    });

    it("a user-supplied target_formats wins over the requested format (and fetch says what is missing)", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      await provider().start(req({ prompt: "x", texture: false, params: { target_formats: ["glb", "obj"] } }), t.ctx);
      expect(t.calls[0]!.body!["target_formats"]).toEqual(["glb", "obj"]);
    });
  });

  describe("params passthrough", () => {
    it("shallow-merges req.params last into an image body (overriding adapter fields)", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      await provider().start(
        req({
          inputs: [input({ ref: "u", url: "https://example.com/p.png" })],
          params: { should_texture: false, topology: "quad", target_polycount: 20000, pose_mode: "t-pose", geometry_resolution: "2k" },
        }),
        t.ctx,
      );
      expect(t.calls[0]!.body).toEqual({
        image_url: "https://example.com/p.png",
        should_texture: false, // params win
        target_formats: ["glb"],
        topology: "quad",
        target_polycount: 20000,
        pose_mode: "t-pose",
        geometry_resolution: "2k",
      });
    });

    it("ignores refine-only params when texture is off, with a warning", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      await provider().start(req({ prompt: "x", texture: false, params: { enable_pbr: true } }), t.ctx);
      expect(t.calls[0]!.body).not.toHaveProperty("enable_pbr");
      expect(t.warnings.join()).toMatch(/enable_pbr/);
    });

    it("warns about a quality it cannot map", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      await provider().start(req({ prompt: "x", quality: "ultra" }), t.ctx);
      expect(t.warnings.join()).toMatch(/quality "ultra"/);
    });
  });

  describe("credentials", () => {
    it("fails clearly, before any request, when no key is set", async () => {
      const t = makeCtx([], { secrets: {} });
      await expect(provider().start(req({ prompt: "x" }), t.ctx)).rejects.toThrow(/meshy: no API key\. Set MESHY_API_KEY/);
      expect(t.calls).toHaveLength(0);
    });

    it("prefers apiKeyEnv, then falls back to MESHY_API_KEY", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }, { status: 202, json: { result: TASK_ID } }], {
        secrets: { MY_MESHY: "msy_custom", MESHY_API_KEY: KEY },
      });
      await provider({ apiKeyEnv: "MY_MESHY" }).start(req({ prompt: "x" }), t.ctx);
      expect(t.calls[0]!.headers["Authorization"]).toBe("Bearer msy_custom");
      await provider({ apiKeyEnv: "UNSET_VAR" }).start(req({ prompt: "x" }), t.ctx);
      expect(t.calls[1]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    });

    it("resolves the key per call (a rotated key is picked up)", async () => {
      const secrets: Record<string, string> = { MESHY_API_KEY: "msy_one" };
      const t = makeCtx([{ json: running(TASK_ID, 1) }, { json: running(TASK_ID, 2) }], { secrets });
      const p = provider();
      const h: JobHandle = { id: TASK_ID, kind: "image", stage: "single", format: "glb" };
      await p.poll!(h, t.ctx);
      secrets["MESHY_API_KEY"] = "msy_two";
      await p.poll!(h, t.ctx);
      expect(t.calls.map((c) => c.headers["Authorization"])).toEqual(["Bearer msy_one", "Bearer msy_two"]);
    });
  });

  describe("API errors", () => {
    it("surfaces the Meshy message for a 400 (docs example body)", async () => {
      const t = makeCtx([{ status: 400, json: { message: "Invalid model file extension: .3dm" } }]);
      await expect(provider().start(req({ prompt: "x" }), t.ctx)).rejects.toMatchObject({
        vendor: "meshy",
        status: 400,
        message: "meshy: HTTP 400: Invalid model file extension: .3dm",
      });
    });

    it("hints at credits on 402 and never leaks the key", async () => {
      const t = makeCtx([{ status: 402, json: { message: "Insufficient credits" } }]);
      const err = await provider().start(req({ prompt: "x" }), t.ctx).catch((e: unknown) => e as Error);
      expect(err.message).toMatch(/HTTP 402: Insufficient credits \(insufficient credits/);
      expect(err.message).not.toContain(KEY);
    });

    it("keeps a non-JSON error body", async () => {
      const t = makeCtx([{ status: 502, text: "<html>Bad gateway</html>" }]);
      await expect(provider().start(req({ prompt: "x" }), t.ctx)).rejects.toThrow(/HTTP 502: <html>Bad gateway<\/html>/);
    });

    it("errors when the create response has no task id", async () => {
      const t = makeCtx([{ status: 202, json: {} }]);
      await expect(provider().start(req({ prompt: "x" }), t.ctx)).rejects.toThrow(/no task id/);
    });
  });

  describe("baseUrl", () => {
    it("overrides the host and tolerates a trailing slash", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }, { json: running(TASK_ID, 5) }]);
      const p = provider({ baseUrl: "http://localhost:8080/proxy/" });
      const h = await p.start(req({ prompt: "x", texture: false }), t.ctx);
      await p.poll!(h, t.ctx);
      expect(t.calls[0]!.url).toBe("http://localhost:8080/proxy/openapi/v2/text-to-3d");
      expect(t.calls[1]!.url).toBe(`http://localhost:8080/proxy/openapi/v2/text-to-3d/${TASK_ID}`);
    });
  });

  describe("cancel", () => {
    const h: JobHandle = { id: REFINE_ID, kind: "text", stage: "refine", previewId: TASK_ID, refineId: REFINE_ID, format: "glb" };

    it("deletes a PENDING task (refunded) even when the run signal is already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      const t = makeCtx([{ json: running(REFINE_ID, 0, "PENDING") }, { status: 200, text: "" }], { signal: ac.signal });
      await provider().cancel!(h, t.ctx);
      expect(t.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${BASE}/openapi/v2/text-to-3d/${REFINE_ID}`,
        `DELETE ${BASE}/openapi/v2/text-to-3d/${REFINE_ID}`,
      ]);
    });

    it("leaves an IN_PROGRESS or finished task alone (DELETE would 409 or discard a paid result)", async () => {
      const t = makeCtx([{ json: running(REFINE_ID, 40) }, { json: succeeded(REFINE_ID) }]);
      await provider().cancel!(h, t.ctx);
      await provider().cancel!(h, t.ctx);
      expect(t.calls.every((c) => c.method === "GET")).toBe(true);
    });

    it("tolerates a 409 when the task started between the check and the delete", async () => {
      const t = makeCtx([
        { json: running(REFINE_ID, 0, "PENDING") },
        { status: 409, json: { message: "Task is IN_PROGRESS and cannot be deleted." } },
      ]);
      await expect(provider().cancel!(h, t.ctx)).resolves.toBeUndefined();
    });
  });

  describe("handle hygiene", () => {
    it("rejects a foreign handle", async () => {
      const t = makeCtx([]);
      await expect(provider().poll!({ id: "abc" }, t.ctx)).rejects.toThrow(/not a Meshy handle/);
    });

    it("handles are JSON round-trippable and carry no secrets", async () => {
      const t = makeCtx([{ status: 202, json: { result: TASK_ID } }]);
      const h = await provider().start(req({ prompt: "x" }), t.ctx);
      const copy = JSON.parse(JSON.stringify(h)) as JobHandle;
      expect(copy).toEqual(h);
      expect(JSON.stringify(h)).not.toMatch(/msy_|Bearer/);
    });
  });
});
