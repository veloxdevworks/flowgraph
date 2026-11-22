import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph, type GraphSpec } from "@flowgraph/core";
import "./index.js";
import { openaiVendor } from "./vendors/openai.js";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const response = () =>
  new Response(
    JSON.stringify({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        input_tokens_details: { text_tokens: 2, image_tokens: 0 },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
async function setup(retry = false) {
  const cwd = await mkdtemp(join(tmpdir(), "fg-media-retry-"));
  dirs.push(cwd);
  const provider = openaiVendor.create({ name: "art", apiKeyEnv: "FGQA_IMAGE_KEY" });
  const spec = {
    metadata: { name: "retry" },
    nodes: [
      {
        id: "img",
        type: "image",
        provider: "art",
        ...(retry ? { retry: { maxAttempts: 2, baseMs: 1, jitter: false } } : {}),
        with: { prompt: "test" },
      },
    ],
    edges: [
      { from: "START", to: "img" },
      { from: "img", to: "END" },
    ],
    runtime: { budget: { maxUSD: 1, onExceed: "fail" } },
  } as unknown as GraphSpec;
  return { cwd, provider, spec };
}
it.each([400, 429])(
  "a rejected HTTP %s request leaves no uncertain receipt and permits retry",
  async (status) => {
    vi.stubEnv("FGQA_IMAGE_KEY", "dummy");
    const f = await setup(true);
    let calls = 0;
    const fetcher = vi.fn(async () =>
      ++calls === 1
        ? new Response(JSON.stringify({ error: { message: "rejected" } }), { status })
        : response(),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await (
      await compileGraph(f.spec, { cwd: f.cwd, mediaProviders: [f.provider] })
    ).run({ threadId: "retry" });
    expect(result).toMatchObject({
      status: "completed",
      usage: { calls: 2, unknownCalls: 0, unpricedCalls: 0, pendingCalls: 0 },
    });
    expect(calls).toBe(2);
  },
);
it("a missing API key is zero usage and recovers without manual media/usage reconciliation", async () => {
  vi.stubEnv("FGQA_IMAGE_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  const f = await setup();
  const fetcher = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetcher);
  const g = await compileGraph(f.spec, { cwd: f.cwd, mediaProviders: [f.provider] });
  expect(await g.run({ threadId: "key" })).toMatchObject({
    status: "error",
    usage: { costUSD: 0, unknownCalls: 0, unpricedCalls: 0, pendingCalls: 0 },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(join(f.cwd, ".flowgraph/jobs/key"))).toEqual([]);
  vi.stubEnv("FGQA_IMAGE_KEY", "dummy");
  expect(await g.resume({ threadId: "key", resume: true })).toMatchObject({
    status: "completed",
    usage: { unknownCalls: 0, pendingCalls: 0 },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("a 400 after an accepted request cannot erase uncertain paid work", async () => {
  vi.stubEnv("FGQA_IMAGE_KEY", "dummy");
  const f = await setup();
  const provider = {
    ...f.provider,
    async start(_req: unknown, ctx: Parameters<typeof f.provider.start>[1]) {
      await ctx.fetch("https://local/submit", { method: "POST" });
      throw Object.assign(new Error("later operation failed"), { status: 400 });
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("accepted", { status: 200 })),
  );
  const g = await compileGraph(f.spec, { cwd: f.cwd, mediaProviders: [provider] });
  expect(await g.run({ threadId: "accepted" })).toMatchObject({
    status: "error",
    usage: { unknownCalls: 1 },
  });
  expect((await g.resume({ threadId: "accepted", resume: true })).error?.message).toMatch(
    /uncertain outcome/,
  );
});
