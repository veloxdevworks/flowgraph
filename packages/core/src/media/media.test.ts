import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AudioWithSchema, ImageWithSchema, Model3dWithSchema, VideoWithSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { defineNode, describeNodeTypes, registry } from "../registry.js";
import { z } from "zod";
import { deriveMediaProviders, registerMediaVendor } from "./registry.js";
import type { JobHandle, JobStatus, MediaCallContext, MediaProvider, MediaRequest } from "./types.js";

// 1x1 transparent PNG
const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

interface FakeCalls {
  start: MediaRequest[];
  poll: number;
  fetch: number;
  cancel: number;
}

function syncProvider(calls: FakeCalls, over: Partial<MediaProvider> = {}): MediaProvider {
  return {
    name: "fake",
    vendor: "fake",
    modalities: ["image", "video", "model3d"],
    async start(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
      calls.start.push(req);
      const done = [];
      for (let i = 0; i < req.count; i++) {
        done.push(await ctx.saveOutput({ bytes: PNG_1x1, mimeType: "image/png" }));
      }
      return { id: `sync-${calls.start.length}`, done };
    },
    estimateCostUSD: (req) => 0.04 * req.count,
    ...over,
  };
}

function asyncProvider(calls: FakeCalls, statuses: JobStatus[], over: Partial<MediaProvider> = {}): MediaProvider {
  let n = 0;
  return {
    name: "fake",
    vendor: "fake",
    modalities: ["image", "video", "model3d"],
    pollIntervalMs: 1,
    async start(req: MediaRequest): Promise<JobHandle> {
      calls.start.push(req);
      return { id: `job-${calls.start.length}` };
    },
    async poll(): Promise<JobStatus> {
      calls.poll++;
      return statuses[Math.min(n++, statuses.length - 1)]!;
    },
    async fetch(_h: JobHandle, ctx: MediaCallContext) {
      calls.fetch++;
      return [await ctx.saveOutput({ bytes: PNG_1x1, mimeType: "image/png" })];
    },
    async cancel() {
      calls.cancel++;
    },
    ...over,
  };
}

const newCalls = (): FakeCalls => ({ start: [], poll: 0, fetch: 0, cancel: 0 });

function graph(nodes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): GraphSpec {
  const ids = nodes.map((n) => String(n["id"]));
  const edges: Array<{ from: string; to: string }> = [{ from: "START", to: ids[0]! }];
  for (let i = 0; i < ids.length - 1; i++) edges.push({ from: ids[i]!, to: ids[i + 1]! });
  edges.push({ from: ids[ids.length - 1]!, to: "END" });
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "media-graph" },
    nodes,
    edges,
    runtime: { checkpoint: { enabled: false, backend: "memory" } },
    ...extra,
  } as unknown as GraphSpec;
}

type Outputs = Record<string, { artifact: { path: string; mimeType: string; role: string; meta?: Record<string, unknown> }; artifacts: unknown[]; count: number; reused: boolean; costUSD: number }>;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fg-media-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("media with-schemas", () => {
  it("image requires a prompt and defaults count", () => {
    expect(ImageWithSchema.safeParse({}).success).toBe(false);
    const ok = ImageWithSchema.parse({ prompt: "a cat" });
    expect(ok.count).toBe(1);
  });
  it("video needs a prompt or an input", () => {
    expect(VideoWithSchema.safeParse({}).success).toBe(false);
    expect(VideoWithSchema.safeParse({ prompt: "pan" }).success).toBe(true);
    expect(VideoWithSchema.safeParse({ input: "{{ state.outputs.img }}" }).success).toBe(true);
  });
  it("model3d defaults format to glb and needs prompt or input", () => {
    expect(Model3dWithSchema.safeParse({}).success).toBe(false);
    expect(Model3dWithSchema.parse({ prompt: "a chair" }).format).toBe("glb");
  });
});

describe("image node", () => {
  it("saves a synchronous provider's output as an Artifact on disk", async () => {
    const calls = newCalls();
    const compiled = await compileGraph(
      graph([{ id: "img", type: "image", provider: "fake", with: { prompt: "a red fox", count: 2 } }]),
      { cwd: dir, mediaProviders: [syncProvider(calls, { maxPerJob: { image: 4 } })] },
    );
    const res = await compiled.run({ threadId: "t1" });
    expect(res.status).toBe("completed");
    const out = (res.state["outputs"] as Outputs)["img"]!;
    expect(out.count).toBe(2);
    expect(out.artifact.role).toBe("image");
    expect(out.artifact.mimeType).toBe("image/png");
    expect(out.artifact.meta).toMatchObject({ width: 1, height: 1, source: { provider: "fake", prompt: "a red fox" } });
    expect(out.artifact.path.startsWith(".flowgraph/artifacts/t1/img/")).toBe(true);
    expect((await stat(path.join(dir, out.artifact.path))).size).toBe(PNG_1x1.byteLength);
    expect(calls.start).toHaveLength(1);
    expect(calls.start[0]!.prompt).toBe("a red fox");
    expect(out.costUSD).toBeCloseTo(0.08);
  });

  it("charges the vendor-reported cost of a synchronous call instead of the estimate", async () => {
    const calls = newCalls();
    const provider = syncProvider(calls, {
      async start(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
        calls.start.push(req);
        return { id: "s", costUSD: 0.123, done: [await ctx.saveOutput({ bytes: PNG_1x1, mimeType: "image/png" })] };
      },
    });
    const compiled = await compileGraph(
      graph([{ id: "img", type: "image", provider: "fake", with: { prompt: "x" } }]),
      { cwd: dir, mediaProviders: [provider] },
    );
    const res = await compiled.run({ threadId: "tcost" });
    expect((res.state["outputs"] as Outputs)["img"]!.costUSD).toBeCloseTo(0.123);
  });

  it("splits a count larger than maxPerJob into separate jobs", async () => {
    const calls = newCalls();
    const compiled = await compileGraph(
      graph([{ id: "img", type: "image", provider: "fake", with: { prompt: "x", count: 5 } }]),
      { cwd: dir, mediaProviders: [syncProvider(calls, { maxPerJob: { image: 2 } })] },
    );
    const res = await compiled.run({ threadId: "t2" });
    expect(res.status).toBe("completed");
    expect(calls.start.map((r) => r.count).sort()).toEqual([1, 2, 2]);
    expect((res.state["outputs"] as Outputs)["img"]!.count).toBe(5);
  });

  it("fails clearly when the provider does not exist", async () => {
    const compiled = await compileGraph(
      graph([{ id: "img", type: "image", provider: "nope", with: { prompt: "x" } }]),
      { cwd: dir, mediaProviders: [syncProvider(newCalls())] },
    );
    const res = await compiled.run({ threadId: "t3" });
    expect(res.status).toBe("error");
    expect(String(res.error?.message ?? res.error)).toMatch(/no media provider named "nope"/);
  });

  it("picks the only candidate when the node names no provider", async () => {
    const calls = newCalls();
    const compiled = await compileGraph(graph([{ id: "img", type: "image", with: { prompt: "x" } }]), {
      cwd: dir,
      mediaProviders: [syncProvider(calls)],
    });
    expect((await compiled.run({ threadId: "t4" })).status).toBe("completed");
    expect(calls.start).toHaveLength(1);
  });
});

describe("async jobs and the journal", () => {
  it("polls to completion, collects outputs, and reuses them on a replay in the same thread", async () => {
    const calls = newCalls();
    const provider = asyncProvider(calls, [{ state: "queued" }, { state: "running", progress: 40 }, { state: "done", costUSD: 0.5 }]);
    const g = graph([{ id: "vid", type: "video", provider: "fake", with: { prompt: "waves", duration: 4 } }]);

    const first = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "tv" });
    expect(first.status).toBe("completed");
    expect(calls.start).toHaveLength(1);
    expect(calls.fetch).toBe(1);
    expect((first.state["outputs"] as Outputs)["vid"]!.costUSD).toBe(0.5);
    expect((first.state["outputs"] as Outputs)["vid"]!.reused).toBe(false);

    const second = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "tv" });
    expect(second.status).toBe("completed");
    expect(calls.start).toHaveLength(1); // not submitted again
    expect((second.state["outputs"] as Outputs)["vid"]!.reused).toBe(true);
    expect((second.state["outputs"] as Outputs)["vid"]!.costUSD).toBe(0);
  });

  it("re-attaches to an in-flight job after a crash instead of submitting again", async () => {
    const calls = newCalls();
    let crashed = false;
    const provider = asyncProvider(calls, [{ state: "running" }, { state: "done" }], {
      async poll(): Promise<JobStatus> {
        calls.poll++;
        if (!crashed) {
          crashed = true;
          throw new Error("simulated process crash while polling");
        }
        return { state: "done" };
      },
    });
    const g = graph([{ id: "m", type: "model3d", provider: "fake", with: { prompt: "a chair" } }]);

    const first = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "tc" });
    expect(first.status).toBe("error");
    expect(calls.start).toHaveLength(1);

    const second = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "tc" });
    expect(second.status).toBe("completed");
    expect(calls.start).toHaveLength(1); // the journaled job was resumed, not resubmitted
    expect(calls.fetch).toBe(1);
  });

  it("journals a replacement handle from poll so a crash after a stage switch does not repeat the paid stage", async () => {
    const calls = newCalls();
    const created: string[] = [];
    let crashAfterStage = true;
    const provider = asyncProvider(calls, [], {
      async start(req: MediaRequest): Promise<JobHandle> {
        calls.start.push(req);
        return { id: "preview-1", stage: "preview" };
      },
      async poll(h: JobHandle): Promise<JobStatus> {
        calls.poll++;
        if (h["stage"] === "preview") {
          created.push("refine"); // the paid second stage is created here
          return { state: "running", progress: 50, handle: { id: "refine-1", stage: "refine" } };
        }
        if (crashAfterStage) {
          crashAfterStage = false;
          throw new Error("simulated crash right after the stage switch");
        }
        return { state: "done" };
      },
    });
    const g = graph([{ id: "m", type: "model3d", provider: "fake", with: { prompt: "a chair" } }]);

    const first = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "ts" });
    expect(first.status).toBe("error");
    const second = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "ts" });
    expect(second.status).toBe("completed");
    expect(calls.start).toHaveLength(1);
    expect(created).toEqual(["refine"]); // created once, not again after the crash
  });

  it("clears the journal when a job fails so a retry submits a fresh job", async () => {
    const calls = newCalls();
    const provider = asyncProvider(calls, [{ state: "failed", error: "content policy" }]);
    const g = graph([{ id: "img", type: "image", provider: "fake", with: { prompt: "x" } }]);

    const first = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "tf" });
    expect(first.status).toBe("error");
    expect(String(first.error?.message ?? first.error)).toMatch(/content policy/);

    await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "tf" });
    expect(calls.start).toHaveLength(2);
    const journalDir = path.join(dir, ".flowgraph", "jobs", "tf");
    const left = await readdir(journalDir).catch(() => [] as string[]);
    expect(left).toHaveLength(0);
  });

  it("keeps the journal on timeout so a later retry can re-attach", async () => {
    const calls = newCalls();
    const provider = asyncProvider(calls, [{ state: "running" }], { pollIntervalMs: 20 });
    const g = graph([{ id: "vid", type: "video", provider: "fake", with: { prompt: "x", timeout: "50ms" } }]);
    const res = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "tt" });
    expect(res.status).toBe("error");
    expect(String(res.error?.message ?? res.error)).toMatch(/re-attach/);
    const left = await readdir(path.join(dir, ".flowgraph", "jobs", "tt"));
    expect(left).toHaveLength(1);
  });

  it("cancels the vendor job and drops the journal on abort", async () => {
    const calls = newCalls();
    const ac = new AbortController();
    const provider = asyncProvider(calls, [{ state: "running" }], {
      pollIntervalMs: 5,
      async poll(): Promise<JobStatus> {
        calls.poll++;
        if (calls.poll === 2) ac.abort();
        return { state: "running" };
      },
    });
    const g = graph([{ id: "vid", type: "video", provider: "fake", with: { prompt: "x" } }]);
    const res = await (await compileGraph(g, { cwd: dir, mediaProviders: [provider] })).run({ threadId: "ta", signal: ac.signal });
    expect(res.status).not.toBe("completed");
    // The run may return before the node finishes cancelling; wait for the cleanup.
    await vi.waitFor(async () => {
      expect(calls.cancel).toBe(1);
      const left = await readdir(path.join(dir, ".flowgraph", "jobs", "ta")).catch(() => [] as string[]);
      expect(left).toHaveLength(0);
    });
  });
});

describe("chaining and inputs", () => {
  it("passes a media node's output to the next node as a reference input", async () => {
    const calls = newCalls();
    const compiled = await compileGraph(
      graph([
        { id: "img", type: "image", provider: "fake", with: { prompt: "a castle" } },
        { id: "vid", type: "video", provider: "fake", with: { prompt: "fly through", input: "{{ state.outputs.img }}" } },
      ]),
      { cwd: dir, mediaProviders: [syncProvider(calls)] },
    );
    const res = await compiled.run({ threadId: "tch" });
    expect(res.status).toBe("completed");
    const videoReq = calls.start[1]!;
    expect(videoReq.modality).toBe("video");
    expect(videoReq.inputs).toHaveLength(1);
    expect(videoReq.inputs[0]!.mimeType).toBe("image/png");
    const bytes = await videoReq.inputs[0]!.bytes();
    expect(Buffer.from(bytes).equals(Buffer.from(PNG_1x1))).toBe(true);
    expect(await videoReq.inputs[0]!.dataUri()).toMatch(/^data:image\/png;base64,/);
  });

  it("infers model3d mode from the number of inputs", async () => {
    const calls = newCalls();
    const compiled = await compileGraph(
      graph([
        { id: "img", type: "image", provider: "fake", with: { prompt: "a mug" } },
        { id: "m", type: "model3d", provider: "fake", with: { input: "{{ state.outputs.img }}" } },
      ]),
      { cwd: dir, mediaProviders: [syncProvider(calls)] },
    );
    expect((await compiled.run({ threadId: "tm" })).status).toBe("completed");
    expect(calls.start[1]!.mode).toBe("image");
    expect(calls.start[1]!.format).toBe("glb");
  });

  it("rejects an input path outside the run workspace", async () => {
    const calls = newCalls();
    const compiled = await compileGraph(
      graph([{ id: "vid", type: "video", provider: "fake", with: { prompt: "x", input: "../../../../etc/hostname" } }]),
      { cwd: dir, mediaProviders: [syncProvider(calls)] },
    );
    const res = await compiled.run({ threadId: "tp" });
    expect(res.status).toBe("error");
    expect(calls.start).toHaveLength(0);
  });
});

describe("credentials are configured once", () => {
  it("a langchain xai entry doubles as a media provider with the same key settings", () => {
    const seen: Array<Record<string, unknown>> = [];
    registerMediaVendor({
      vendor: "xai",
      modalities: ["image", "video"],
      defaultApiKeyEnv: "XAI_API_KEY",
      create(opts) {
        seen.push({ ...opts });
        return { name: opts.name, vendor: "xai", modalities: ["image", "video"], async start() { return { id: "x" }; } };
      },
    });
    const derived = deriveMediaProviders({
      grok: { kind: "langchain", vendor: "xai", model: "grok-4", apiKeyEnv: "MY_XAI_KEY" },
      claude: { kind: "langchain", vendor: "anthropic" },
    });
    expect(derived.map((p) => p.name)).toEqual(["grok"]); // anthropic has no media side
    expect(seen[0]).toMatchObject({ name: "grok", apiKeyEnv: "MY_XAI_KEY" });
    expect(seen[0]!["model"]).toBeUndefined(); // the LLM model id is not a media model
  });

  it("defaults the key env when the entry sets none, and rejects unknown media vendors", () => {
    const derived = deriveMediaProviders({ g: { kind: "langchain", vendor: "xai" } });
    expect(derived).toHaveLength(1);
    expect(() => deriveMediaProviders({ t: { kind: "media", vendor: "does-not-exist" } })).toThrow(/unknown media vendor/);
  });

  it("a graph's providers: block resolves media nodes by entry name", async () => {
    const calls = newCalls();
    registerMediaVendor({
      vendor: "fakevendor",
      modalities: ["image"],
      create: (opts) => syncProvider(calls, { name: opts.name, vendor: "fakevendor", modalities: ["image"] }),
    });
    const compiled = await compileGraph(
      graph([{ id: "img", type: "image", provider: "pics", with: { prompt: "x" } }], {
        providers: { pics: { kind: "media", vendor: "fakevendor" } },
      }),
      { cwd: dir },
    );
    const res = await compiled.run({ threadId: "tg" });
    expect(res.status).toBe("completed");
    expect(calls.start).toHaveLength(1);
    const file = (res.state["outputs"] as Outputs)["img"]!.artifact.path;
    expect((await readFile(path.join(dir, file))).byteLength).toBe(PNG_1x1.byteLength);
  });
});

describe("node type descriptors (for palettes and generic inspectors)", () => {
  it("lists the media nodes with display metadata and a JSON Schema", () => {
    const all = describeNodeTypes();
    const image = all.find((d) => d.type === "image")!;
    expect(image).toMatchObject({ label: "Image", category: "media", icon: "image" });
    expect(image.capabilities.sideEffecting).toBe(true);
    const props = (image.configSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["prompt", "count", "input"]));
    expect(all.find((d) => d.type === "model3d")?.category).toBe("media");
  });

  it("lists plugin node types, defaulting the category to custom", () => {
    const type = `acme.test.${Math.random().toString(36).slice(2, 8)}`;
    registry.register(
      defineNode({
        type,
        configSchema: z.object({ bucket: z.string() }),
        capabilities: {},
        build: () => ({ contract: {}, capabilities: {}, run: async () => ({ update: {} }) }),
      }),
    );
    const d = describeNodeTypes().find((x) => x.type === type)!;
    expect(d.label).toBe(type);
    expect(d.category).toBe("custom");
    expect((d.configSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("bucket");
  });
});

describe("audio node (speech, sound effects, music)", () => {
  const MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);
  const audioProvider = (calls: FakeCalls, over: Partial<MediaProvider> = {}): MediaProvider => ({
    name: "voice",
    vendor: "fakeaudio",
    modalities: ["audio"],
    async start(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
      calls.start.push(req);
      return { id: "a1", done: [await ctx.saveOutput({ bytes: MP3, mimeType: "audio/mpeg", meta: { durationMs: 1200 } })] };
    },
    ...over,
  });

  it("validates per kind", () => {
    expect(AudioWithSchema.safeParse({ kind: "speech" }).success).toBe(false);
    expect(AudioWithSchema.safeParse({ kind: "speech", text: "hello" }).success).toBe(true);
    expect(AudioWithSchema.safeParse({ kind: "sfx" }).success).toBe(false);
    expect(AudioWithSchema.safeParse({ kind: "sfx", prompt: "door slam", duration: 2 }).success).toBe(true);
    expect(AudioWithSchema.safeParse({ kind: "music" }).success).toBe(false);
    expect(AudioWithSchema.safeParse({ kind: "music", prompt: "lofi beat", instrumental: true }).success).toBe(true);
    expect(AudioWithSchema.safeParse({ kind: "music", text: "la la la" }).success).toBe(true);
    expect(AudioWithSchema.safeParse({ kind: "podcast", prompt: "x" }).success).toBe(false);
  });

  it("passes speech fields to the provider and saves an audio artifact", async () => {
    const calls = newCalls();
    const compiled = await compileGraph(
      graph([
        {
          id: "vo",
          type: "audio",
          provider: "voice",
          model: "some-model",
          with: { kind: "speech", text: "Welcome to the show", voice: "narrator", language: "en", format: "mp3" },
        },
      ]),
      { cwd: dir, mediaProviders: [audioProvider(calls)] },
    );
    const res = await compiled.run({ threadId: "au1" });
    expect(res.status).toBe("completed");
    expect(calls.start[0]).toMatchObject({
      modality: "audio",
      audioKind: "speech",
      text: "Welcome to the show",
      voice: "narrator",
      language: "en",
      format: "mp3",
      model: "some-model",
    });
    const out = (res.state["outputs"] as Outputs)["vo"]!;
    expect(out.artifact).toMatchObject({ mimeType: "audio/mpeg", role: "audio" });
    expect(out.artifact.path.endsWith(".mp3")).toBe(true);
    expect(out.artifact.meta).toMatchObject({ durationMs: 1200 });
  });

  it("different text is a different job (fingerprint), same text is reused", async () => {
    const calls = newCalls();
    const mk = (text: string) =>
      graph([{ id: "vo", type: "audio", provider: "voice", with: { kind: "speech", text } }]);
    const run = async (text: string) =>
      (await compileGraph(mk(text), { cwd: dir, mediaProviders: [audioProvider(calls)] })).run({ threadId: "au2" });
    await run("one");
    await run("two");
    await run("one");
    expect(calls.start).toHaveLength(2);
  });

  it("picks the provider that supports the requested audio kind", async () => {
    const speechCalls = newCalls();
    const musicCalls = newCalls();
    const speech = audioProvider(speechCalls, { name: "speech-only", audioKinds: ["speech", "sfx"] });
    const music = audioProvider(musicCalls, { name: "music-only", audioKinds: ["music"] });
    const compiled = await compileGraph(
      graph([{ id: "song", type: "audio", with: { kind: "music", prompt: "synthwave", instrumental: true } }]),
      { cwd: dir, mediaProviders: [speech, music] },
    );
    expect((await compiled.run({ threadId: "au3" })).status).toBe("completed");
    expect(speechCalls.start).toHaveLength(0);
    expect(musicCalls.start[0]).toMatchObject({ audioKind: "music", instrumental: true, prompt: "synthwave" });
  });

  it("names the kind when a chosen provider cannot make it", async () => {
    const compiled = await compileGraph(
      graph([{ id: "vo", type: "audio", provider: "music-only", with: { kind: "speech", text: "hi" } }]),
      { cwd: dir, mediaProviders: [audioProvider(newCalls(), { name: "music-only", audioKinds: ["music"] })] },
    );
    const res = await compiled.run({ threadId: "au4" });
    expect(res.status).toBe("error");
    expect(String(res.error?.message ?? res.error)).toMatch(/does not support audio \(speech\)/);
  });

  it("is listed for palettes", () => {
    expect(describeNodeTypes().find((d) => d.type === "audio")).toMatchObject({ category: "media", icon: "audio-lines" });
  });
});
