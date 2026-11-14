import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileJournal } from "./journal.js";
import { runMediaJob } from "./run-job.js";
import type { MediaCallContext, MediaProvider, MediaRequest } from "./types.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const req: MediaRequest = { modality: "image", prompt: "test", inputs: [], count: 1, params: {} };
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "fg-media-intent-"));
  dirs.push(workspace);
  const journal = createFileJournal({
    workspace,
    scope: "thread",
    nodeId: "image",
    fingerprint: "hash",
  });
  const mctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: undefined,
    fetch,
    secrets: { get: async () => undefined, has: () => false },
    saveOutput: async () => {
      throw new Error("unused");
    },
  } as MediaCallContext;
  return { workspace, journal, mctx, req, timeout: "1s", emit: vi.fn() };
}
it("persists submission intent before entering a synchronous provider", async () => {
  const opts = await fixture();
  const provider: MediaProvider = {
    name: "fake",
    vendor: "fake",
    modalities: ["image"],
    start: async (_req, ctx) => {
      expect(await opts.journal.read()).toMatchObject({ state: "intent", provider: "fake" });
      expect((ctx as MediaCallContext & { submissionId?: string }).submissionId).toBeTruthy();
      return { id: "done", done: [], costUSD: 0.02 };
    },
  };
  expect(await runMediaJob({ ...opts, provider })).toMatchObject({ costUSD: 0.02 });
});
it("does not resubmit an uncertain synchronous request on retry", async () => {
  const opts = await fixture();
  const start = vi.fn(async () => {
    throw new Error("request outcome lost");
  });
  const provider: MediaProvider = { name: "fake", vendor: "fake", modalities: ["image"], start };
  await expect(runMediaJob({ ...opts, provider })).rejects.toThrow("outcome lost");
  await expect(runMediaJob({ ...opts, provider })).rejects.toMatchObject({
    code: "MEDIA_SUBMISSION_UNCERTAIN",
  });
  expect(start).toHaveBeenCalledTimes(1);
});
it("refuses a corrupt journal instead of silently submitting again", async () => {
  const opts = await fixture();
  await opts.journal.write({
    version: 1,
    state: "submitted",
    provider: "fake",
    submittedAt: new Date().toISOString(),
    handle: { id: "job" },
  });
  const dir = join(opts.workspace, ".flowgraph", "jobs", "thread");
  await writeFile(join(dir, (await readdir(dir))[0]!), "{broken");
  const start = vi.fn(async () => ({ id: "new", done: [] }));
  await expect(
    runMediaJob({
      ...opts,
      provider: { name: "fake", vendor: "fake", modalities: ["image"], start },
    }),
  ).rejects.toMatchObject({ code: "MEDIA_JOURNAL_INVALID" });
  expect(start).not.toHaveBeenCalled();
});

it("requires the inspected intent id to reconcile and reuses recovered completed results", async () => {
  const opts = await fixture();
  const { resolveMediaSubmission } = await import("./journal.js");
  const start = vi.fn(async () => {
    throw new Error("lost response");
  });
  const provider: MediaProvider = { name: "fake", vendor: "fake", modalities: ["image"], start };
  await expect(runMediaJob({ ...opts, provider })).rejects.toThrow("lost response");
  const entry = (await opts.journal.read())!;
  await expect(
    resolveMediaSubmission(opts.journal, "wrong", { notSubmitted: true }),
  ).rejects.toThrow(/identity/);
  await writeFile(join(opts.workspace, "recovered.png"), "image");
  await resolveMediaSubmission(opts.journal, entry.submissionId!, {
    handle: {
      id: "recovered",
      done: [{ kind: "artifact", path: "recovered.png", mimeType: "image/png", sizeBytes: 5 }],
      costUSD: 0.03,
    },
  });
  expect(await runMediaJob({ ...opts, provider })).toMatchObject({ reused: true, costUSD: 0 });
  expect(start).toHaveBeenCalledTimes(1);
});
it("allows only one submission for concurrent callers sharing a file journal", async () => {
  const opts = await fixture();
  const start = vi.fn(async () => ({ id: "one", done: [] }));
  const provider: MediaProvider = { name: "fake", vendor: "fake", modalities: ["image"], start };
  await Promise.allSettled([
    runMediaJob({ ...opts, provider }),
    runMediaJob({ ...opts, provider }),
  ]);
  expect(start).toHaveBeenCalledTimes(1);
});
