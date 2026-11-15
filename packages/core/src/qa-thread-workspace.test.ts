import { afterEach, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph } from "./compiler.js";
import { readThreadWorkspace } from "./runtime/thread-workspace.js";
import type { MediaProvider } from "./media/types.js";
import { WORKSPACE_CHANNEL, WORKSPACE_NODES_CHANNEL } from "./runtime/state-annotation.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
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
function graph(nodes: unknown[], extra = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "pinned-workspace" },
    nodes,
    edges: [
      { from: "START", to: (nodes[0] as { id: string }).id },
      ...nodes.map((node, index) => ({
        from: (node as { id: string }).id,
        to: (nodes[index + 1] as { id: string } | undefined)?.id ?? "END",
      })),
    ],
    ...extra,
  });
}
const gate = { id: "gate", type: "hitl", with: { mode: "approve", message: "Continue?" } };
const effect = {
  id: "effect",
  type: "shell",
  with: {
    command: process.execPath,
    args: ["-e", "require('node:fs').appendFileSync('effects.txt', 'once\\n')"],
  },
};

it("reuses an uncertain paid media journal after recompiling from a different cwd", async () => {
  const f = await fixture();
  const start = vi.fn(async () => {
    throw new Error("vendor response lost after submission");
  });
  const media: MediaProvider = { name: "paid", vendor: "paid", modalities: ["image"], start };
  const spec = graph([
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

it("continues shell effects in the pinned cwd and keeps embedded workspace overrides", async () => {
  const f = await fixture();
  await mkdir(join(f.original, "child"));
  const child = graph([effect], { runtime: { workspace: "child" } });
  const spec = graph([gate, { id: "nested", type: "subgraph", spec: child }, effect]);
  const first = await (
    await compileGraph(spec, { cwd: f.original, graphPath: f.graphPath, checkpointer: f.saver })
  ).run({ threadId: "shell" });
  expect(first.status).toBe("interrupted");
  const resumed = await (
    await compileGraph(spec, { cwd: f.other, graphPath: f.graphPath, checkpointer: f.saver })
  ).resume({ threadId: "shell", resume: true });
  expect(resumed.status, String(resumed.error)).toBe("completed");
  expect(await readFile(join(f.original, "effects.txt"), "utf8")).toBe("once\n");
  expect(await readFile(join(f.original, "child/effects.txt"), "utf8")).toBe("once\n");
  await expect(readFile(join(f.other, "effects.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["option", "runtime", "node"])(
  "refuses a changed explicit %s workspace before replaying pending work",
  async (mode) => {
    const f = await fixture();
    const spec = graph([gate, effect]);
    await (
      await compileGraph(spec, { cwd: f.original, graphPath: f.graphPath, checkpointer: f.saver })
    ).run({ threadId: mode });
    const changed = structuredClone(spec);
    if (mode === "runtime") changed.runtime = { workspace: f.other };
    if (mode === "node") changed.nodes[1]!.workspace = f.other;
    const resumed = await compileGraph(changed, {
      cwd: f.other,
      graphPath: f.graphPath,
      checkpointer: f.saver,
      ...(mode === "option" ? { workspace: f.other } : {}),
    });
    await expect(resumed.resume({ threadId: mode, resume: true })).rejects.toMatchObject({
      code: "THREAD_WORKSPACE_MISMATCH",
    });
    await expect(readFile(join(f.other, "effects.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("requires an explicit original workspace for legacy checkpoints and pins the confirmed folder", async () => {
  const f = await fixture(),
    spec = graph([gate, effect]);
  await (
    await compileGraph(spec, { cwd: f.original, graphPath: f.graphPath, checkpointer: f.saver })
  ).run({ threadId: "legacy" });
  const saved = (await f.saver.getTuple({ configurable: { thread_id: "legacy" } }))!;
  const values = { ...saved.checkpoint.channel_values };
  delete values[WORKSPACE_CHANNEL];
  delete values[WORKSPACE_NODES_CHANNEL];
  await f.saver.put(
    { configurable: { thread_id: "legacy" } },
    { ...saved.checkpoint, channel_values: values },
    saved.metadata!,
  );
  expect(await readThreadWorkspace(f.saver, "legacy")).toBeUndefined();
  const unknown = await compileGraph(spec, {
    cwd: f.other,
    graphPath: f.graphPath,
    checkpointer: f.saver,
  });
  await expect(unknown.resume({ threadId: "legacy", resume: true })).rejects.toMatchObject({
    code: "THREAD_WORKSPACE_REQUIRED",
  });
  const confirmed = await compileGraph(spec, {
    cwd: f.other,
    workspace: f.original,
    graphPath: f.graphPath,
    checkpointer: f.saver,
  });
  expect((await confirmed.resume({ threadId: "legacy", resume: true })).status).toBe("completed");
  expect(await readThreadWorkspace(f.saver, "legacy")).toBe(f.original);
});

it("awaits the saved binding before entering a paid provider", async () => {
  const f = await fixture();
  let blocked!: () => void, release!: () => void;
  const atWrite = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = f.saver.put.bind(f.saver);
  let held = false;
  f.saver.put = async (...args) => {
    if (!held && args[1].channel_values[WORKSPACE_CHANNEL]) {
      held = true;
      blocked();
      await hold;
    }
    return put(...args);
  };
  const start = vi.fn(async () => {
    expect(await readThreadWorkspace(f.saver, "barrier")).toBe(f.original);
    return { id: "done", done: [], costUSD: 0 };
  });
  const media: MediaProvider = { name: "paid", vendor: "paid", modalities: ["image"], start };
  const spec = graph([
    { id: "image", type: "image", provider: "paid", with: { prompt: "poster" } },
  ]);
  const running = (
    await compileGraph(spec, {
      cwd: f.original,
      graphPath: f.graphPath,
      checkpointer: f.saver,
      mediaProviders: [media],
    })
  ).run({ threadId: "barrier" });
  await atWrite;
  expect(start).not.toHaveBeenCalled();
  release();
  expect((await running).status).toBe("completed");
  expect(start).toHaveBeenCalledTimes(1);
});

it("refuses workspace edits in a file-based child before submitting media again", async () => {
  const f = await fixture();
  const childPath = join(f.graphPath, "..", "child.graph.yaml");
  const media: MediaProvider = {
    name: "paid",
    vendor: "paid",
    modalities: ["image"],
    start: vi.fn(async () => {
      throw new Error("response lost");
    }),
  };
  const child = graph(
    [{ id: "image", type: "image", provider: "paid", with: { prompt: "poster" } }],
    { runtime: { workspace: "first" } },
  );
  await mkdir(join(f.original, "first"));
  await writeFile(childPath, JSON.stringify(child));
  const spec = graph([{ id: "child", type: "subgraph", uses: "./child.graph.yaml" }]);
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

it("protects the original root during changed-cwd historical replay and keeps branch discovery consistent", async () => {
  const f = await fixture(),
    spec = graph([effect, gate]);
  const original = await compileGraph(spec, {
    cwd: f.original,
    graphPath: f.graphPath,
    checkpointer: f.saver,
  });
  await original.run({ threadId: "forked" });
  const checkpointId = (await original.getStateHistory("forked")).find((state) =>
    state.next.includes("effect"),
  )!.checkpointId!;
  const changed = await compileGraph(spec, {
    cwd: f.other,
    graphPath: f.graphPath,
    checkpointer: f.saver,
  });
  await expect(
    changed.resumeFrom({
      threadId: "forked",
      checkpointId,
      replayWorkspace: f.original,
      resume: true,
    }),
  ).rejects.toMatchObject({ code: "HISTORICAL_REPLAY_WORKSPACE_REQUIRED" });
  const fork = join(f.other, "fork");
  expect(
    (
      await changed.resumeFrom({
        threadId: "forked",
        checkpointId,
        replayWorkspace: fork,
        resume: true,
      })
    ).status,
  ).toBe("interrupted");
  expect(await readThreadWorkspace(f.saver, "forked")).toBe(fork);
  await expect(
    changed.resumeFrom({ threadId: "forked", checkpointId, replayWorkspace: fork, resume: true }),
  ).rejects.toMatchObject({ code: "HISTORICAL_REPLAY_WORKSPACE_REQUIRED" });
  await expect(changed.run({ threadId: "forked" })).rejects.toMatchObject({
    code: "THREAD_REPLAY_BRANCH",
  });
  expect((await changed.resume({ threadId: "forked", resume: true })).status).toBe("completed");
  expect(await readFile(join(f.original, "effects.txt"), "utf8")).toBe("once\n");
  expect(await readFile(join(fork, "effects.txt"), "utf8")).toBe("once\n");
});

it("does not let caller input replace the engine-owned workspace binding", async () => {
  const f = await fixture(),
    spec = graph([effect]);
  const compiled = await compileGraph(spec, {
    cwd: f.original,
    graphPath: f.graphPath,
    checkpointer: f.saver,
  });
  await expect(
    compiled.run({ threadId: "forged", input: { [WORKSPACE_CHANNEL]: f.other } }),
  ).rejects.toThrow(/reserved/i);
  expect(await readThreadWorkspace(f.saver, "forged")).toBeUndefined();
  await expect(readFile(join(f.other, "effects.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});
