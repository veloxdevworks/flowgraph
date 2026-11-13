/**
 * End to end: a real graph through the real engine and the real vendor
 * adapters. Only the network is stubbed (global fetch), so this proves the
 * glue (providers: block -> media provider -> request -> artifact on disk),
 * not that the vendors' live APIs accept these requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileGraph } from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";
import "./index.js"; // registers the vendors

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

type Seen = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function stubFetch(handler: (req: Seen) => Response | undefined): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const req: Seen = {
        url: String(url),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).entries()),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      };
      seen.push(req);
      const res = handler(req);
      if (!res) throw new Error(`unexpected request: ${req.method} ${req.url}`);
      return res;
    }),
  );
  return seen;
}

const graph = (nodes: unknown[], providers: unknown): GraphSpec =>
  ({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "e2e" },
    providers,
    nodes,
    edges: [
      { from: "START", to: (nodes[0] as { id: string }).id },
      { from: (nodes[0] as { id: string }).id, to: "END" },
    ],
    runtime: { checkpoint: { enabled: false, backend: "memory" } },
  }) as unknown as GraphSpec;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fg-media-e2e-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("end to end with the real adapters (network stubbed)", () => {
  it("an xAI entry configured once for LLMs also generates an image", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    const seen = stubFetch((r) => {
      if (r.url === "https://api.x.ai/v1/images/generations") {
        return new Response(
          JSON.stringify({ data: [{ url: "https://imgen.x.ai/abc.png", mime_type: "image/png" }], usage: { cost_in_usd_ticks: 400_000_000 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (r.url === "https://imgen.x.ai/abc.png") {
        return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
      }
      return undefined;
    });

    const compiled = await compileGraph(
      graph([{ id: "pic", type: "image", provider: "grok", with: { prompt: "a lighthouse", aspectRatio: "16:9" } }], {
        grok: { kind: "langchain", vendor: "xai", model: "grok-4" }, // the LLM entry, configured once
      }),
      { cwd: dir },
    );
    const res = await compiled.run({ threadId: "e1" });
    expect(res.status).toBe("completed");

    const gen = seen.find((r) => r.url.endsWith("/images/generations"))!;
    expect(gen.headers["authorization"]).toBe("Bearer xai-test-key");
    expect(gen.body).toMatchObject({ prompt: "a lighthouse", aspect_ratio: "16:9" });
    expect((gen.body as { model: string }).model).not.toBe("grok-4"); // the LLM model id is not used for images
    // The key is only ever sent to the API host, never to the CDN download.
    expect(seen.find((r) => r.url.startsWith("https://imgen.x.ai/"))!.headers["authorization"]).toBeUndefined();

    const out = (res.state["outputs"] as Record<string, { artifact: { path: string; mimeType: string; role: string; meta?: Record<string, unknown> }; costUSD: number }>)["pic"]!;
    expect(out.artifact).toMatchObject({ mimeType: "image/png", role: "image" });
    expect(out.costUSD).toBeCloseTo(0.04, 8); // the vendor-reported cost, not an estimate
    expect(Buffer.from(await readFile(path.join(dir, out.artifact.path))).equals(Buffer.from(PNG))).toBe(true);
  });

  it("a missing key fails with an actionable message and makes no network call", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("GROK_API_KEY", "");
    const seen = stubFetch(() => undefined);
    const compiled = await compileGraph(
      graph([{ id: "pic", type: "image", provider: "grok", with: { prompt: "x" } }], { grok: { kind: "langchain", vendor: "xai" } }),
      { cwd: dir },
    );
    const res = await compiled.run({ threadId: "e2" });
    expect(res.status).toBe("error");
    expect(String(res.error?.message ?? res.error)).toMatch(/XAI_API_KEY/);
    expect(seen).toHaveLength(0);
  });

  it("ElevenLabs speech through a kind: media entry saves an mp3", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-test-key");
    const MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);
    const seen = stubFetch((r) =>
      r.url.startsWith("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb")
        ? new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg" } })
        : undefined,
    );
    const compiled = await compileGraph(
      graph(
        [{ id: "vo", type: "audio", provider: "voices", with: { kind: "speech", voice: "JBFqnCBsd6RMkjVDRZzb", text: "Welcome back." } }],
        { voices: { kind: "media", vendor: "elevenlabs" } },
      ),
      { cwd: dir },
    );
    const res = await compiled.run({ threadId: "e3" });
    expect(res.status).toBe("completed");
    expect(seen[0]!.headers["xi-api-key"]).toBe("el-test-key");
    expect(seen[0]!.body).toMatchObject({ text: "Welcome back." });
    const out = (res.state["outputs"] as Record<string, { artifact: { path: string; mimeType: string; role: string } }>)["vo"]!;
    expect(out.artifact).toMatchObject({ mimeType: "audio/mpeg", role: "audio" });
    expect(out.artifact.path.endsWith(".mp3")).toBe(true);
  });
});
