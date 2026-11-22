import { afterEach, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileGraph,
  inspectThreadUsage,
  readThreadWorkspace,
  type FlowgraphEvent,
} from "@flowgraph/core";
import {
  createFileJournal,
  listMediaJournals,
  resolveMediaSubmission,
  type MediaProvider,
} from "./index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function simpleGraph(
  nodes: unknown[],
  extra: Record<string, unknown> = {},
  edges?: Array<{ from: string; to: string | string[] }>,
): GraphSpec {
  const defaultEdges = [
    { from: "START", to: (nodes[0] as { id: string }).id },
    ...nodes.map((node, index) => ({
      from: (node as { id: string }).id,
      to: (nodes[index + 1] as { id: string } | undefined)?.id ?? "END",
    })),
  ];
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "media-integration" },
    nodes,
    edges: edges ?? defaultEdges,
    ...extra,
  });
}

it("PLAT-383: media token usage enters run totals and reused results do not double charge", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fg-image-usage-"));
  dirs.push(cwd);
  const spec = simpleGraph([{ id: "work", type: "image", provider: "image-usage", with: { prompt: "draw" } }]);
  const provider: MediaProvider = {
    name: "image-usage",
    vendor: "test",
    modalities: ["image"],
    start: async (_req, ctx) => ({
      id: "done",
      done: [await ctx.saveOutput({ bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png" })],
      usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 },
      costUSD: 0.1,
    }),
  };
  const g = await compileGraph(spec, { cwd, mediaProviders: [provider] });
  expect(await g.run({ threadId: "tokens" })).toMatchObject({
    status: "completed",
    usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150, costUSD: 0.1 },
  });
  expect(await g.run({ threadId: "tokens" })).toMatchObject({
    status: "completed",
    usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150, costUSD: 0.1, calls: 1 },
  });
});

it("PLAT-365/366: discovers media identities and persists idempotent resolution across journal reopen", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "fg-recovery-"));
  dirs.push(workspace);
  const options = { workspace, scope: "t", nodeId: "fan[2]", fingerprint: "0123456789abcdef" };
  const journal = createFileJournal(options);
  await journal.write({ version: 1, state: "intent", provider: "vendor", submittedAt: "now", submissionId: "s", handle: { id: "s" } });
  expect(await listMediaJournals(workspace, "t")).toMatchObject([
    { nodeId: "fan[2]", fingerprint: options.fingerprint, submissionId: "s" },
  ]);
  await resolveMediaSubmission(journal, "s", { notSubmitted: true });
  await resolveMediaSubmission(createFileJournal(options), "s", { notSubmitted: true });
  await expect(
    resolveMediaSubmission(createFileJournal(options), "s", { handle: { id: "real" } }),
  ).rejects.toMatchObject({ code: "MEDIA_RESOLUTION_CONFLICT" });
});

it("uses separate media journals and artifact paths for two mapped nodes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-qa-map-media-"));
  dirs.push(dir);
  let starts = 0;
  const events: FlowgraphEvent[] = [];
  const provider: MediaProvider = {
    name: "qa-media",
    vendor: "qa",
    modalities: ["image"],
    async start(_req, ctx) {
      const id = String(++starts);
      const artifact = await ctx.saveOutput({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      });
      return { id, done: [artifact] };
    },
  };
  const mediaMap = (id: string) => ({
    id,
    type: "map",
    with: {
      over: "{{ ['same'] }}",
      node: { type: "image", with: { provider: "qa-media", prompt: "same" } },
      collect: { to: "results" },
    },
  });
  const spec = simpleGraph(
    [mediaMap("views-a"), mediaMap("views-b")],
    { state: { channels: { results: { type: "array" } } } },
    [
      { from: "START", to: "views-a" },
      { from: "views-a", to: "views-b" },
      { from: "views-b", to: "END" },
    ],
  );
  const result = await (
    await compileGraph(spec, {
      cwd: dir,
      mediaProviders: [provider],
      sinks: [
        (e) => {
          events.push(e);
        },
      ],
    })
  ).run({ threadId: "qa-media-map" });
  expect(result.status).toBe("completed");
  expect(starts).toBe(2);
  const jobs = events
    .filter((e) => e.type === "custom.media.job")
    .map((e) => e.data as { nodeId: string });
  expect(new Set(jobs.map((e) => e.nodeId))).toEqual(new Set(["views-a[0]", "views-b[0]"]));
  expect(JSON.stringify(result.state)).not.toContain("/undefined/");
});

it("PLAT-359: an ordinary fan-out rejection leaves no never-started sibling receipts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fg-paid-siblings-"));
  dirs.push(cwd);
  const seen: string[] = [];
  let reject = true;
  const nodes = ["a", "b", "c"].map((id) => ({
    id,
    type: "image",
    provider: "siblings",
    with: { prompt: id },
  }));
  const spec = simpleGraph(
    nodes,
    { runtime: { budget: { maxTokens: 100, onExceed: "fail" } } },
    [
      { from: "START", to: ["a", "b", "c"] },
      ...nodes.map((n) => ({ from: n.id, to: "END" })),
    ],
  );
  const provider: MediaProvider = {
    name: "siblings",
    vendor: "test",
    modalities: ["image"],
    async start(req) {
      seen.push(req.prompt!);
      if (reject && req.prompt === "a")
        throw Object.assign(new Error("invalid request"), { mediaSubmissionRejected: true });
      return { id: req.prompt!, done: [], costUSD: 0 };
    },
  };
  const saver = new MemorySaver();
  const compiled = await compileGraph(spec, {
    cwd,
    checkpointer: saver,
    mediaProviders: [provider],
  });
  const first = await compiled.run({ threadId: "siblings" });
  expect(first.status).toBe("error");
  expect(first.usage?.unknownCalls).toBe(0);
  await vi.waitFor(async () =>
    expect(Object.keys((await inspectThreadUsage(saver, "siblings")).pending)).toHaveLength(0),
  );
  reject = false;
  const next = await compiled.resume({ threadId: "siblings", resume: true });
  expect(next.status).toBe("completed");
  expect(next.usage?.pendingCalls).toBe(0);
});

async function workspaceFixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fg-thread-workspace-")));
  dirs.push(dir);
  const original = join(dir, "original folder"),
    other = join(dir, "other folder"),
    graphs = join(dir, "my graphs");
  await Promise.all([original, other, graphs].map((folder) => mkdir(folder)));
  return {
    original,
    other,
    graphPath: join(graphs, "saved flow.graph.yaml"),
    saver: new MemorySaver(),
  };
}

it("reuses an uncertain paid media journal after recompiling from a different cwd", async () => {
  const f = await workspaceFixture();
  const start = vi.fn(async () => {
    throw new Error("vendor response lost after submission");
  });
  const media: MediaProvider = { name: "paid", vendor: "paid", modalities: ["image"], start };
  const spec = simpleGraph([
    { id: "image", type: "image", provider: "paid", with: { prompt: "poster" } },
  ]);
  const first = await (
    await compileGraph(spec, {
      cwd: f.original,
      graphPath: f.graphPath,
      checkpointer: f.saver,
      mediaProviders: [media],
    })
  ).run({ threadId: "paid" });
  expect(first.status).toBe("error");
  expect(await readThreadWorkspace(f.saver, "paid")).toBe(f.original);
  const resumed = await (
    await compileGraph(spec, {
      cwd: f.other,
      graphPath: f.graphPath,
      checkpointer: f.saver,
      mediaProviders: [media],
    })
  ).resume({ threadId: "paid", resume: true });
  expect(resumed).toMatchObject({ status: "error", error: { code: "MEDIA_SUBMISSION_UNCERTAIN" } });
  expect(start).toHaveBeenCalledTimes(1);
});

it("refuses workspace edits in a file-based child before submitting media again", async () => {
  const f = await workspaceFixture();
  const childPath = join(f.graphPath, "..", "child.graph.yaml");
  const media: MediaProvider = {
    name: "paid",
    vendor: "paid",
    modalities: ["image"],
    start: vi.fn(async () => {
      throw new Error("response lost");
    }),
  };
  const child = simpleGraph(
    [{ id: "image", type: "image", provider: "paid", with: { prompt: "poster" } }],
    { runtime: { workspace: "first" } },
  );
  await mkdir(join(f.original, "first"));
  await writeFile(childPath, JSON.stringify(child));
  const spec = simpleGraph([{ id: "child", type: "subgraph", uses: "./child.graph.yaml" }]);
  const options = { graphPath: f.graphPath, checkpointer: f.saver, mediaProviders: [media] };
  expect(
    (await (await compileGraph(spec, { ...options, cwd: f.original })).run({ threadId: "child" }))
      .status,
  ).toBe("error");
  child.runtime = { workspace: "other" };
  await writeFile(childPath, JSON.stringify(child));
  const resumed = await compileGraph(spec, { ...options, cwd: f.other });
  await expect(resumed.resume({ threadId: "child", resume: true })).rejects.toMatchObject({
    code: "THREAD_WORKSPACE_MISMATCH",
  });
  expect(media.start).toHaveBeenCalledTimes(1);
});

it("rejects an unaffordable known media estimate before purchasing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-budget-media-"));
  dirs.push(dir);
  const start = vi.fn(async () => ({ id: "job", done: [], costUSD: 0.02 }));
  const g = await compileGraph(
    simpleGraph([{ id: "image", type: "image", provider: "media-qa", with: { prompt: "cat" } }], {
      runtime: { budget: { maxUSD: 0.01, onExceed: "fail" } },
    }),
    { cwd: dir, mediaProviders: [{ name: "media-qa", vendor: "qa", modalities: ["image"], estimateCostUSD: () => 0.02, start }] },
  );
  expect(await g.run()).toMatchObject({ status: "error", usage: { costUSD: 0, calls: 0 } });
  expect(start).not.toHaveBeenCalled();
});

it("emits synchronous media completion with cost and includes it in run totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-cost-media-"));
  dirs.push(dir);
  const g = await compileGraph(
    simpleGraph([{ id: "image", type: "image", provider: "media-qa", with: { prompt: "cat" } }]),
    { cwd: dir, mediaProviders: [{ name: "media-qa", vendor: "qa", modalities: ["image"], start: async () => ({ id: "job", done: [], costUSD: 0.02 }) }] },
  );
  const events: unknown[] = [];
  g.events.subscribe((event) => {
    if (event.type === "custom.media.job") events.push(event.data);
  });
  expect(await g.run()).toMatchObject({ status: "completed", usage: { costUSD: 0.02, calls: 1 } });
  expect(events).toContainEqual(expect.objectContaining({ phase: "done", costUSD: 0.02 }));
});

it("serializes unknown-cost media admission under a hard cap, bounding fanout overshoot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-cost-fanout-"));
  dirs.push(dir);
  const start = vi.fn(async () => ({ id: "job", done: [], costUSD: 0.02 }));
  const g = await compileGraph(
    simpleGraph([{ id: "image", type: "image", provider: "media-qa", with: { prompt: "cat", count: 4 } }], {
      runtime: { budget: { maxUSD: 0.01, onExceed: "fail" } },
    }),
    { cwd: dir, mediaProviders: [{ name: "media-qa", vendor: "qa", modalities: ["image"], maxPerJob: { image: 1 }, start }] },
  );
  expect(await g.run()).toMatchObject({ status: "error", usage: { costUSD: 0.02, calls: 1 } });
  expect(start).toHaveBeenCalledTimes(1);
});

it.each([false, null, { approved: false }])("does not purchase after a denied budget interrupt (%j)", async (answer) => {
  const dir = await mkdtemp(join(tmpdir(), "fg-budget-deny-"));
  dirs.push(dir);
  const start = vi.fn(async () => ({ id: "job", done: [], costUSD: 0.02 }));
  const g = await compileGraph(
    simpleGraph([{ id: "image", type: "image", provider: "media-qa", with: { prompt: "cat" } }], {
      runtime: { budget: { maxUSD: 0.01, onExceed: "interrupt" } },
    }),
    { cwd: dir, mediaProviders: [{ name: "media-qa", vendor: "qa", modalities: ["image"], estimateCostUSD: () => 0.02, start }] },
  );
  expect((await g.run({ threadId: "denied" })).status).toBe("interrupted");
  expect(await g.resume({ threadId: "denied", resume: answer })).toMatchObject({
    status: "error",
    error: { code: "BUDGET_DENIED" },
    usage: { calls: 0 },
  });
  expect(start).not.toHaveBeenCalled();
});
