import { afterEach, expect, it, vi } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { mkdtemp, writeFile, rm, symlink, truncate } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphSpecSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { createLangChainProvider, type ChatModelLike } from "./providers/langchain/provider.js";
import { createScriptedProvider } from "./providers/index.js";
import { fromStoredMessage } from "./context/messages.js";
import { resolveAgentImages, imageContentBlocks } from "./providers/images.js";
import { NODE_POLICY } from "./node-policy.js";
import type { NodeRunContext } from "./context.js";
import type { AgentRequest, ProviderRunContext } from "./providers/types.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KjIAAAAASUVORK5CYII=",
  "base64",
);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "fg-agent-image-"));
  dirs.push(dir);
  await writeFile(join(dir, "picture.png"), PNG);
  return dir;
}
function graph(images: unknown, context?: unknown) {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "agent-images" },
    state: { channels: { reference: { type: "object" }, messages: { type: "messages" } } },
    nodes: [
      {
        id: "inspect",
        type: "agent",
        provider: "vision",
        with: { prompt: "Describe this picture", images, ...(context ? { context } : {}) },
      },
    ],
    edges: [
      { from: "START", to: "inspect" },
      { from: "inspect", to: "END" },
    ],
  });
}
function model() {
  const calls: BaseMessage[][] = [];
  const invoke = vi.fn(async (messages: BaseMessage[]) => {
    calls.push(messages);
    return new AIMessage({
      content: "a tiny image",
      usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    } as ConstructorParameters<typeof AIMessage>[0]);
  });
  return {
    calls,
    invoke,
    provider: createLangChainProvider({ invoke } satisfies ChatModelLike, { name: "vision" }),
  };
}
function imageBlocks(messages: BaseMessage[]) {
  return messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((b) => typeof b === "object" && b.type === "image_url")
      : [],
  );
}

it("attaches a workspace image to the stock LangChain agent's actual model message", async () => {
  const dir = await directory(),
    fake = model();
  const result = await (
    await compileGraph(graph(["./picture.png"]), { cwd: dir, providers: [fake.provider] })
  ).run();
  expect(result.status, String(result.error)).toBe("completed");
  expect(imageBlocks(fake.calls[0]!)).toEqual([
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "auto" },
    },
  ]);
});

it("accepts an Artifact resolved from state with per-image detail", async () => {
  const dir = await directory(),
    fake = model();
  const compiled = await compileGraph(
    graph([{ path: "{{ state.reference.path }}", detail: "low" }]),
    { cwd: dir, providers: [fake.provider] },
  );
  const result = await compiled.run({
    input: {
      reference: {
        kind: "artifact",
        path: "picture.png",
        mimeType: "image/png",
        sizeBytes: PNG.length,
        role: "image",
      },
    },
  });
  expect(result.status).toBe("completed");
  expect(imageBlocks(fake.calls[0]!)).toContainEqual(
    expect.objectContaining({ image_url: expect.objectContaining({ detail: "low" }) }),
  );
});

it("preserves image history as immutable artifact refs without checkpointing base64", async () => {
  const dir = await directory(),
    fake = model();
  await writeFile(join(dir, "second.png"), PNG);
  const compiled = await compileGraph(
    graph("{{ state.reference }}", {
      history: "messages",
      strategy: "trim",
      maxTokens: 8000,
      reserveTokens: 100,
    }),
    { cwd: dir, providers: [fake.provider] },
  );
  const first = await compiled.run({
    threadId: "image-chat",
    input: { reference: { path: "picture.png" } },
  });
  expect(first.status).toBe("completed");
  await rm(join(dir, "picture.png"));
  const second = await compiled.run({
    threadId: "image-chat",
    input: { reference: { path: "second.png" } },
  });
  expect(second.status, String(second.error)).toBe("completed");
  expect(imageBlocks(fake.calls[1]!)).toHaveLength(2);
  const messages = second.state.messages as unknown[];
  expect(JSON.stringify(messages)).not.toContain(PNG.toString("base64"));
  const stored = messages.map((m) => fromStoredMessage(JSON.parse(JSON.stringify(m))));
  expect(stored.filter((m) => m?.role === "user").every((m) => m!.images?.length === 1)).toBe(true);
});

it("refuses unsupported providers before invoking or billing them", async () => {
  const dir = await directory();
  const run = vi.fn(() => ({ output: "text only", stopReason: "done" as const }));
  const compiled = await compileGraph(graph(["picture.png"]), {
    cwd: dir,
    providers: [createScriptedProvider("vision", run)],
  });
  const result = await compiled.run();
  expect(result.status).toBe("error");
  expect(result.error).toMatchObject({ code: "PROVIDER_IMAGE_INPUT_UNSUPPORTED" });
  expect(run).not.toHaveBeenCalled();
  expect(result.usage?.calls).toBe(0);
});

it("rejects non-images and workspace-escaping symlinks before the model call", async () => {
  const dir = await directory(),
    outside = await directory(),
    fake = model();
  await writeFile(join(dir, "not-image.txt"), "private text");
  await symlink(join(outside, "picture.png"), join(dir, "outside.png"));
  for (const path of ["not-image.txt", "outside.png"]) {
    const result = await (
      await compileGraph(graph([path]), { cwd: dir, providers: [fake.provider] })
    ).run();
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({
      code: path === "outside.png" ? "IMAGE_PATH_OUTSIDE_WORKSPACE" : "IMAGE_FORMAT_UNSUPPORTED",
    });
  }
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("enforces host file restrictions while still allowing supplied inline image bytes", async () => {
  const dir = await directory(),
    fake = model();
  const options = { cwd: dir, providers: [fake.provider], nodePolicy: { blockImageFiles: true } };
  const denied = await (await compileGraph(graph(["picture.png"]), options)).run();
  expect(denied.error).toMatchObject({ code: "IMAGE_FILE_BLOCKED" });
  const accepted = await (
    await compileGraph(graph([`data:image/png;base64,${PNG.toString("base64")}`]), options)
  ).run();
  expect(accepted.status, String(accepted.error)).toBe("completed");
  expect(fake.invoke).toHaveBeenCalledTimes(1);
});

it("includes image token estimates in context fitting before calling a model", async () => {
  const dir = await directory(),
    fake = model();
  const result = await (
    await compileGraph(
      graph([{ path: "picture.png", estimatedTokens: 4096 }], {
        maxTokens: 1024,
        reserveTokens: 100,
      }),
      { cwd: dir, providers: [fake.provider] },
    )
  ).run();
  expect(result.status).toBe("error");
  expect(result.error).toMatchObject({ code: "CONTEXT_OVERFLOW" });
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("fetches URL images before the model call and applies outbound policy to redirects", async () => {
  const dir = await directory(),
    fake = model();
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/image" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/redirect`;
    const accepted = await (
      await compileGraph(graph([url]), { cwd: dir, providers: [fake.provider] })
    ).run();
    expect(accepted.status, String(accepted.error)).toBe("completed");
    expect(imageBlocks(fake.calls[0]!)).toHaveLength(1);
    const denied = await (
      await compileGraph(graph([url + "?token=private-token"]), {
        cwd: dir,
        providers: [fake.provider],
        nodePolicy: { outboundHttp: { publicOnly: true } },
      })
    ).run();
    expect(denied.error).toMatchObject({ code: "OUTBOUND_ADDRESS_BLOCKED" });
    expect(String(denied.error)).not.toContain("private-token");
    expect(fake.invoke).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("rejects oversized files and missing rendered image refs before a model call", async () => {
  const dir = await directory(),
    fake = model();
  await truncate(join(dir, "picture.png"), 20 * 1024 * 1024 + 1);
  for (const images of [["picture.png"], "{{ state.reference }}"]) {
    const result = await (
      await compileGraph(graph(images), { cwd: dir, providers: [fake.provider] })
    ).run();
    expect(result.status).toBe("error");
  }
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("does not allow forged history to read another thread's snapshots, including sanitized-id collisions", async () => {
  const dir = await directory();
  const context = (threadId: string) =>
    Object.assign(
      {
        workspace: dir,
        nodeId: "inspect",
        meta: { threadId, runId: "r", graph: "images", startedAt: "" },
        config: {},
      },
      { [NODE_POLICY]: { blockImageFiles: true } },
    ) as unknown as NodeRunContext;
  const images = await resolveAgentImages(
    [`data:image/png;base64,${PNG.toString("base64")}`],
    context("a/b"),
  );
  await expect(imageContentBlocks(images, context("a_b"))).rejects.toMatchObject({
    code: "IMAGE_FILE_BLOCKED",
  });
  expect(await imageContentBlocks(images, context("a/b"))).toHaveLength(1);
});

it("refuses changed image inputs during crash replay before repeating provider work", async () => {
  const dir = await directory();
  let fail = true;
  const run = vi.fn(async (_req: AgentRequest, ctx: ProviderRunContext) => {
    await ctx.replay?.set("finished-model", "saved");
    if (fail) throw new Error("stopped after completed work");
    return { output: "done", stopReason: "done" as const };
  });
  const provider = createScriptedProvider("vision", run);
  provider.capabilities.imageInput = true;
  const compiled = await compileGraph(graph(["picture.png"]), { cwd: dir, providers: [provider] });
  expect((await compiled.run({ threadId: "replay-image" })).status).toBe("error");
  await writeFile(join(dir, "picture.png"), Buffer.concat([PNG, Buffer.from("changed")]));
  fail = false;
  const resumed = await compiled.resume({ threadId: "replay-image", resume: true });
  expect(resumed.error).toMatchObject({ code: "REPLAY_MISMATCH" });
  expect(run).toHaveBeenCalledTimes(1);
});
