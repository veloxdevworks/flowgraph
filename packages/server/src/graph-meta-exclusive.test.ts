import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileExclusive,
  type GraphStoreHooks,
  listPersistedGraphs,
  MAX_THREAD_ID_LENGTH,
  parseGraphYaml,
  persistGraph,
  readGraphMeta,
  readPersistedGraphYaml,
  updateGraphMeta,
} from "./graph-source.js";
import { RunService } from "./run-service.js";
import type { ThreadOwner } from "./types.js";

const YAML = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: meta-exclusive }
state:
  channels:
    out: { type: string }
nodes:
  - { id: wait, type: hitl, with: { mode: approve, message: "go?" } }
edges:
  - { from: START, to: wait }
  - { from: wait, to: END }
`;
const OTHER_YAML = YAML.replace("meta-exclusive", "other-server");
const spec = (yaml: string) => parseGraphYaml(yaml, { expandEnv: false }).spec!;
const alice: ThreadOwner = { id: "alice", org: "o" };
const bob: ThreadOwner = { id: "bob", org: "o" };

/** Seams for this server's uploads (the other server's copy gets none). */
const graphStoreHooks: GraphStoreHooks = {};
const hooks = { hooks: graphStoreHooks };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete graphStoreHooks.beforeMetaCreate;
  delete graphStoreHooks.beforeGraphMove;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function storeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-meta-exclusive-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A second copy of the graph-store module, with its own per-file write
 * queue: in-process stand-in for another server sharing the directory.
 */
async function otherServer(): Promise<typeof import("./graph-source.js")> {
  vi.resetModules();
  return import("./graph-source.js");
}

/** Let the other server store `threadId` in the window between this one's check and its create. */
function otherServerCreatesFirst(other: typeof import("./graph-source.js"), dir: string, threadId: string, owner: ThreadOwner): void {
  graphStoreHooks.beforeMetaCreate = async () => {
    delete graphStoreHooks.beforeMetaCreate;
    await other.persistGraph(dir, threadId, OTHER_YAML, spec(OTHER_YAML), { owner, status: "running" });
  };
}

const files = async (dir: string) => (await fs.readdir(dir)).sort();

describe("creating a thread's meta file", () => {
  it("refuses with 409 when another server created the same thread first, and changes neither file", async () => {
    const dir = await storeDir();
    const other = await otherServer();
    otherServerCreatesFirst(other, dir, "t", bob);
    await expect(persistGraph(dir, "t", YAML, spec(YAML), { owner: alice, ...hooks })).rejects.toMatchObject({
      status: 409,
      code: "THREAD_ID_CONFLICT",
      message: expect.stringContaining("just created by another request"),
    });
    expect(await readGraphMeta(dir, "t")).toMatchObject({ threadId: "t", owner: bob, graphName: "other-server", status: "running" });
    expect(await fs.readFile(path.join(dir, "t.graph.yaml"), "utf-8")).toBe(OTHER_YAML);
    // No temporary files are left behind by either side.
    expect(await files(dir)).toEqual(["t.graph.yaml", "t.graph.yaml.meta.json"]);
  });

  it("refuses with 409 when another server stored a thread id that shares the file name", async () => {
    const dir = await storeDir();
    const other = await otherServer();
    otherServerCreatesFirst(other, dir, "a_b", bob);
    await expect(persistGraph(dir, "a/b", YAML, spec(YAML), { owner: alice, ...hooks })).rejects.toMatchObject({
      status: 409,
      code: "THREAD_ID_CONFLICT",
      message: expect.stringContaining("collides with another stored thread"),
    });
    expect(await readGraphMeta(dir, "a_b")).toMatchObject({ threadId: "a_b", owner: bob });
    expect(await fs.readFile(path.join(dir, "a_b.graph.yaml"), "utf-8")).toBe(OTHER_YAML);
    expect(await files(dir)).toEqual(["a_b.graph.yaml", "a_b.graph.yaml.meta.json"]);
  });

  it("a run service that loses the create answers 409 and keeps no session", async () => {
    const dir = await storeDir();
    const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 50, authToken: "t" }, { graphStoreHooks });
    await s.init();
    cleanup.push(() => s.close());
    const other = await otherServer();
    otherServerCreatesFirst(other, dir, "shared", bob);
    await expect(s.startRun({ threadId: "shared", yaml: YAML, input: {} })).rejects.toMatchObject({ status: 409, code: "THREAD_ID_CONFLICT" });
    expect(s.registry.get("shared")).toBeUndefined();
    expect(await readGraphMeta(dir, "shared")).toMatchObject({ owner: bob, graphName: "other-server" });
  });

  it("stores a new thread when nobody else creates it", async () => {
    const dir = await storeDir();
    let hookCalls = 0;
    graphStoreHooks.beforeMetaCreate = () => void hookCalls++;
    await persistGraph(dir, "t", YAML, spec(YAML), { owner: alice, ...hooks });
    // Later uploads update the stored thread; only the first one creates it.
    await persistGraph(dir, "t", OTHER_YAML, spec(OTHER_YAML), { owner: bob, ...hooks });
    expect(hookCalls).toBe(1);
    expect(await readGraphMeta(dir, "t")).toMatchObject({ threadId: "t", owner: alice, graphName: "other-server" });
    expect(await files(dir)).toEqual(["t.graph.yaml", "t.graph.yaml.meta.json"]);
  });

  it("gives exactly one of two simultaneous creates the file, always with whole content", async () => {
    const dir = await storeDir();
    const target = path.join(dir, "x.json");
    const one = JSON.stringify({ who: "one", pad: "1".repeat(100_000) });
    const two = JSON.stringify({ who: "two", pad: "2".repeat(100_000) });
    const results = await Promise.allSettled([createFileExclusive(target, one), createFileExclusive(target, two)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "EEXIST" } });
    const winner = results[0]!.status === "fulfilled" ? one : two;
    expect(await fs.readFile(target, "utf-8")).toBe(winner);
    expect(await files(dir)).toEqual(["x.json"]);
  });
});

describe("thread ids", () => {
  it("refuses an over-long thread id with 400, not 503", async () => {
    const dir = await storeDir();
    const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 50, authToken: "t" });
    await s.init();
    cleanup.push(() => s.close());
    const long = "x".repeat(300);
    const invalid = { status: 400, code: "INVALID_THREAD_ID" };
    await expect(s.startRun({ threadId: long, yaml: YAML, input: {} })).rejects.toMatchObject(invalid);
    await expect(s.getRun(long)).rejects.toMatchObject(invalid);
    await expect(s.resumeRun({ threadId: long, resume: {} })).rejects.toMatchObject(invalid);
    await expect(s.getJournal(long)).rejects.toMatchObject(invalid);
    await expect(readGraphMeta(dir, long)).rejects.toMatchObject(invalid);
    await expect(readPersistedGraphYaml(dir, long)).rejects.toMatchObject(invalid);
    await expect(updateGraphMeta(dir, long, { status: "running" })).rejects.toMatchObject(invalid);
    await expect(persistGraph(dir, "y".repeat(MAX_THREAD_ID_LENGTH + 1), YAML, spec(YAML))).rejects.toMatchObject(invalid);
    expect(await files(dir)).toEqual([]);
  });

  it("stores a thread id of the longest allowed length", async () => {
    const dir = await storeDir();
    const id = "z".repeat(MAX_THREAD_ID_LENGTH);
    await persistGraph(dir, id, YAML, spec(YAML), { owner: alice });
    expect(await readGraphMeta(dir, id)).toMatchObject({ threadId: id, owner: alice });
  });

  it("does not patch the record of another thread id that shares the file name", async () => {
    const dir = await storeDir();
    await persistGraph(dir, "a/b", YAML, spec(YAML), { owner: alice, label: "mine" });
    const before = await fs.readFile(path.join(dir, "a_b.graph.yaml.meta.json"), "utf-8");
    await expect(updateGraphMeta(dir, "a_b", { label: "theirs", status: "error" })).rejects.toMatchObject({
      status: 409,
      code: "THREAD_ID_CONFLICT",
    });
    expect(await fs.readFile(path.join(dir, "a_b.graph.yaml.meta.json"), "utf-8")).toBe(before);
    expect(await updateGraphMeta(dir, "a/b", { status: "running" })).toMatchObject({ threadId: "a/b", label: "mine", status: "running" });
  });
});

describe("when moving a new thread's graph into place fails", () => {
  const moveFailed = () => Object.assign(new Error("operation not permitted, rename"), { code: "EPERM" });
  const strayFiles = async (dir: string) => (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"));

  it("keeps the record another server wrote after the claim, so nobody else can take the thread", async () => {
    const dir = await storeDir();
    const other = await otherServer();
    // The same owner's retry lands on another server, which sees the claim and updates the thread.
    graphStoreHooks.beforeGraphMove = async () => {
      await other.persistGraph(dir, "t", OTHER_YAML, spec(OTHER_YAML), { owner: alice, label: "from-other" });
      throw moveFailed();
    };
    await expect(persistGraph(dir, "t", YAML, spec(YAML), { owner: alice, ...hooks })).rejects.toMatchObject({ code: "EPERM" });
    expect(await readGraphMeta(dir, "t")).toMatchObject({ owner: alice, label: "from-other", graphName: "other-server" });
    expect((await readPersistedGraphYaml(dir, "t"))?.yaml).toBe(OTHER_YAML);
    expect(await strayFiles(dir)).toEqual([]);
    // A third server, for another user, finds the thread stored and cannot become its owner.
    const third = await otherServer();
    await third.persistGraph(dir, "t", YAML, spec(YAML), { owner: bob });
    expect(await readGraphMeta(dir, "t")).toMatchObject({ owner: alice });
  });

  it("keeps the claim for its owner, whose next upload stores the graph", async () => {
    const dir = await storeDir();
    graphStoreHooks.beforeGraphMove = () => {
      throw moveFailed();
    };
    await expect(persistGraph(dir, "t", YAML, spec(YAML), { owner: alice, ...hooks })).rejects.toMatchObject({ code: "EPERM" });
    delete graphStoreHooks.beforeGraphMove;
    expect(await readGraphMeta(dir, "t")).toMatchObject({ owner: alice });
    expect(await readPersistedGraphYaml(dir, "t")).toBeNull();
    expect(await strayFiles(dir)).toEqual([]);
    await persistGraph(dir, "t", YAML, spec(YAML), { owner: alice });
    expect(await readPersistedGraphYaml(dir, "t")).toMatchObject({ yaml: YAML, meta: { owner: alice } });
  });
});

describe("listing stored threads", () => {
  it("skips a meta file whose name holds no thread id and lists the rest", async () => {
    const dir = await storeDir();
    await persistGraph(dir, "keep", YAML, spec(YAML), { owner: alice });
    // Left by a host that stored an empty thread id before ids were checked.
    const now = new Date().toISOString();
    await fs.writeFile(path.join(dir, ".graph.yaml.meta.json"), JSON.stringify({ threadId: "", storedAt: now, updatedAt: now, owner: alice }));
    await fs.writeFile(path.join(dir, ".graph.yaml"), YAML);
    const unreadable: string[] = [];
    expect((await listPersistedGraphs(dir, { onUnreadable: (t) => unreadable.push(t) })).map((m) => m.threadId)).toEqual(["keep"]);
    expect(unreadable).toEqual([]);

    const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 50, authToken: "t" });
    await s.init();
    cleanup.push(() => s.close());
    expect((await s.listRuns()).map((r) => r.threadId)).toEqual(["keep"]);
    const claims: string[] = [];
    const owners = { get: async () => null, claim: async (t: string, o: string) => (claims.push(t), { owner: o, created: true }) };
    (s as unknown as { threadOwners: unknown }).threadOwners = owners;
    expect(await s.backfillThreadOwners()).toEqual({ claimed: 1, existing: 0, conflicts: 0, skipped: 0, unreadable: 0 });
    expect(claims).toEqual(["keep"]);
  });
});
