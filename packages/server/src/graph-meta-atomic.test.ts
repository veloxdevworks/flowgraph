import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GraphMetaUnreadableError,
  listPersistedGraphs,
  parseGraphYaml,
  persistGraph,
  readGraphMeta,
  updateGraphMeta,
  writeFileAtomic,
} from "./graph-source.js";
import type { Principal, ServerAuthConfig } from "./identity.js";
import { RunService } from "./run-service.js";

const AUTH: ServerAuthConfig = {
  mode: "oidc",
  explicit: true,
  insecureDev: false,
  oidc: {
    issuer: "https://login.test",
    audience: ["flowgraph"],
    algorithms: ["RS256"],
    clockToleranceSec: 30,
    claims: { org: "org", roles: "roles", teams: "teams", displayName: ["name"] },
    trust: { roles: [], teams: [] },
    defaultProject: "p",
  },
};
const user = (subject: string): Principal => ({
  id: `https://login.test|${subject}`,
  subject,
  issuer: "https://login.test",
  org: "o",
  project: "p",
  teams: [],
  roles: [],
  trusted: false,
  via: "oidc",
});
const owner = user("owner");
const other = user("other");

const YAML = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: meta-atomic }
state:
  channels:
    out: { type: string }
nodes:
  - { id: wait, type: hitl, with: { mode: approve, message: "go?" } }
edges:
  - { from: START, to: wait }
  - { from: wait, to: END }
`;
const spec = () => parseGraphYaml(YAML, { expandEnv: false }).spec!;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function storeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-meta-atomic-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startService(dir: string, threadOwners?: unknown): Promise<RunService> {
  const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 50, auth: AUTH });
  await s.init();
  if (threadOwners) (s as unknown as { threadOwners: unknown }).threadOwners = threadOwners;
  cleanup.push(() => s.close());
  return s;
}

/** An owner registry with no records, so access rests on the owner in the meta file alone. */
const emptyOwners = {
  get: async () => null,
  claim: async (_threadId: string, ownerId: string) => ({ owner: ownerId, created: true }),
};

const metaFile = (dir: string, fileThreadId: string) => path.join(dir, `${fileThreadId}.graph.yaml.meta.json`);

describe("meta writes and concurrent readers", () => {
  it("readers never see a missing meta file or skip the owner check while it is rewritten", async () => {
    const dir = await storeDir();
    const threadId = "team/plan";
    // A large label makes each rewrite take long enough for reads to land inside it.
    await persistGraph(dir, threadId, YAML, spec(), { owner: { id: owner.id, org: owner.org }, label: "L".repeat(20_000) });
    const s = await startService(dir, emptyOwners);

    let done = false;
    const writer = (async () => {
      try {
        for (let i = 0; i < 400; i++) await updateGraphMeta(dir, threadId, { status: i % 2 ? "running" : "interrupted" });
      } finally {
        done = true;
      }
    })();
    let reads = 0;
    let missing = 0;
    let wrongOwner = 0;
    let checks = 0;
    let allowed = 0;
    while (!done) {
      reads++;
      const meta = await readGraphMeta(dir, threadId);
      if (meta === null) missing++;
      else if (meta.owner?.id !== owner.id) wrongOwner++;
      checks++;
      try {
        await s.getRun(threadId, other);
        allowed++;
      } catch (err) {
        expect(err).toMatchObject({ status: 403, code: "THREAD_NOT_OWNED" });
      }
    }
    await writer;
    expect(reads).toBeGreaterThan(50);
    expect({ missing, wrongOwner, allowed }).toEqual({ missing: 0, wrongOwner: 0, allowed: 0 });
    expect(checks).toBe(reads);
    expect((await s.getRun(threadId, owner))?.threadId).toBe(threadId);
    // Writes leave no temporary files behind.
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps every patch when updates to one thread overlap", async () => {
    const dir = await storeDir();
    await persistGraph(dir, "t", YAML, spec(), { owner: { id: owner.id, org: owner.org } });
    await Promise.all([
      updateGraphMeta(dir, "t", { label: "renamed" }),
      updateGraphMeta(dir, "t", { status: "interrupted" }),
      updateGraphMeta(dir, "t", { graphName: "other-name" }),
      persistGraph(dir, "t", YAML, spec(), { owner: { id: other.id, org: other.org } }),
    ]);
    const meta = await readGraphMeta(dir, "t");
    expect(meta).toMatchObject({ label: "renamed", status: "interrupted", owner: { id: owner.id } });
    // persistGraph ran last and sets the graph name from the spec.
    expect(meta?.graphName).toBe("meta-atomic");

    const labels = Array.from({ length: 40 }, (_, i) => `label-${i}`);
    await Promise.all(labels.map((label, i) => updateGraphMeta(dir, "t", i % 2 ? { label } : { status: i % 4 ? "running" : "completed" })));
    expect((await readGraphMeta(dir, "t"))?.label).toBe("label-39");
  });

  it("applies writes for thread ids that share a file one at a time, and keeps the first thread's file", async () => {
    const dir = await storeDir();
    await persistGraph(dir, "a/b", YAML, spec(), { owner: { id: owner.id, org: owner.org } });
    const graphFile = path.join(dir, "a_b.graph.yaml");
    const before = await fs.readFile(graphFile, "utf-8");
    const other_yaml = YAML.replace("meta-atomic", "other-graph");
    const results = await Promise.allSettled([
      ...Array.from({ length: 30 }, (_, i) => updateGraphMeta(dir, "a/b", { label: `label-${i}` })),
      persistGraph(dir, "a_b", other_yaml, parseGraphYaml(other_yaml, { expandEnv: false }).spec!, { owner: { id: other.id, org: other.org } }),
      updateGraphMeta(dir, "a_b", { label: "from-the-other-id" }),
    ]);
    expect(results.slice(0, 30).every((r) => r.status === "fulfilled")).toBe(true);
    expect(results[30]).toMatchObject({ status: "rejected", reason: { status: 409, code: "THREAD_ID_CONFLICT" } });
    const meta = await readGraphMeta(dir, "a/b");
    expect(meta).toMatchObject({ threadId: "a/b", owner: { id: owner.id } });
    // The last queued patch for the shared file wins, in order.
    expect(meta?.label).toBe("from-the-other-id");
    expect(await fs.readFile(graphFile, "utf-8")).toBe(before);
  });

  it("refuses to store a graph over a meta file it cannot read, and leaves both files alone", async () => {
    const dir = await storeDir();
    await persistGraph(dir, "t", YAML, spec(), { owner: { id: owner.id, org: owner.org } });
    await fs.writeFile(metaFile(dir, "t"), '{"threadId":"t","owner":{"id"');
    const other_yaml = YAML.replace("meta-atomic", "other-graph");
    await expect(
      persistGraph(dir, "t", other_yaml, parseGraphYaml(other_yaml, { expandEnv: false }).spec!, { owner: { id: other.id, org: other.org } }),
    ).rejects.toBeInstanceOf(GraphMetaUnreadableError);
    expect(await fs.readFile(path.join(dir, "t.graph.yaml"), "utf-8")).toBe(YAML);
    expect(await fs.readFile(metaFile(dir, "t"), "utf-8")).toBe('{"threadId":"t","owner":{"id"');
  });

  it("writes a file in one step and cleans up when the write fails", async () => {
    const dir = await storeDir();
    const target = path.join(dir, "x.json");
    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two");
    expect(await fs.readFile(target, "utf-8")).toBe("two");
    await expect(writeFileAtomic(path.join(dir, "missing", "x.json"), "three")).rejects.toMatchObject({ code: "ENOENT" });
    // The target is a directory: the rename fails after the temporary file was written.
    await fs.mkdir(path.join(dir, "d.json"));
    await fs.writeFile(path.join(dir, "d.json", "keep"), "");
    await expect(writeFileAtomic(path.join(dir, "d.json"), "four")).rejects.toThrow();
    expect((await fs.readdir(dir)).sort()).toEqual(["d.json", "x.json"]);
  });
});

describe("a thread id that shares another thread's file", () => {
  it("is always refused while the owner's thread is patched, and the owner keeps the thread", async () => {
    const dir = await storeDir();
    const s = await startService(dir);
    await s.startRun({ threadId: "team/plan", yaml: YAML, input: {} }, owner);
    for (let i = 0; i < 500 && s.registry.get("team/plan")?.status !== "interrupted"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.registry.get("team/plan")?.status).toBe("interrupted");
    const graphFile = path.join(dir, "team_plan.graph.yaml");
    const ownersGraph = await fs.readFile(graphFile, "utf-8");
    const otherYaml = YAML.replace("meta-atomic", "other-graph");

    // Status patches as runs make them: some awaited, some not (a resumed run marks itself running without waiting).
    const patchMeta = (s as unknown as { patchMeta(t: string, p: object): void }).patchMeta.bind(s);
    let stop = false;
    let patches = 0;
    const writer = (async () => {
      while (!stop) {
        patchMeta("team/plan", { status: "running" });
        await updateGraphMeta(dir, "team/plan", { status: patches++ % 2 ? "running" : "interrupted" });
      }
    })();
    let attempts = 0;
    const outcomes = new Map<string, number>();
    const end = Date.now() + 2000;
    try {
      while (Date.now() < end) {
        attempts++;
        let outcome: string;
        try {
          await s.startRun({ threadId: "team_plan", yaml: otherYaml, input: {} }, other);
          outcome = "started";
        } catch (err) {
          outcome = `${(err as { status?: number }).status} ${(err as { code?: string }).code}`;
        }
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
        if (outcome === "started") break;
      }
    } finally {
      stop = true;
      await writer;
    }
    expect(Object.fromEntries(outcomes)).toEqual({ "403 THREAD_NOT_OWNED": attempts });
    expect(attempts).toBeGreaterThan(20);
    expect(patches).toBeGreaterThan(20);
    expect(await readGraphMeta(dir, "team/plan")).toMatchObject({ threadId: "team/plan", owner: { id: owner.id } });
    expect(await fs.readFile(graphFile, "utf-8")).toBe(ownersGraph);
    expect((await s.getRun("team/plan", owner))?.threadId).toBe("team/plan");
    await expect(s.getRun("team/plan", other)).rejects.toMatchObject({ status: 403 });
  }, 30_000);
});

describe("unreadable meta files", () => {
  const corruptions: Array<[string, (file: string) => Promise<void>]> = [
    ["cut short", (file) => fs.writeFile(file, '{"threadId":"t","owner":{"id":"')],
    ["empty", (file) => fs.writeFile(file, "")],
    ["JSON without a thread id", (file) => fs.writeFile(file, '{"owner":null}')],
    ["JSON null", (file) => fs.writeFile(file, "null")],
    ["a directory", async (file) => {
      await fs.rm(file);
      await fs.mkdir(file);
    }],
  ];

  for (const [what, corrupt] of corruptions) {
    it(`refuses every caller when the meta file is ${what}`, async () => {
      const dir = await storeDir();
      await persistGraph(dir, "t", YAML, spec(), { owner: { id: owner.id, org: owner.org } });
      await corrupt(metaFile(dir, "t"));
      await expect(readGraphMeta(dir, "t")).rejects.toBeInstanceOf(GraphMetaUnreadableError);
      const s = await startService(dir, emptyOwners);
      const refused = { status: 503, code: "THREAD_META_UNREADABLE" };
      for (const who of [other, owner]) {
        await expect(s.getRun("t", who)).rejects.toMatchObject(refused);
        await expect(s.getState("t", undefined, who)).rejects.toMatchObject(refused);
        await expect(s.startRun({ threadId: "t", yaml: YAML, input: {} }, who)).rejects.toMatchObject(refused);
      }
      // Nothing replaced the file, and listing leaves the thread out.
      await expect(readGraphMeta(dir, "t")).rejects.toBeInstanceOf(GraphMetaUnreadableError);
      expect(await s.listRuns(other)).toEqual([]);
      await expect(updateGraphMeta(dir, "t", { status: "running" })).rejects.toBeInstanceOf(GraphMetaUnreadableError);
    });
  }

  it("treats only a missing file as no stored thread", async () => {
    const dir = await storeDir();
    expect(await readGraphMeta(dir, "never")).toBeNull();
    expect(await updateGraphMeta(dir, "never", { status: "running" })).toBeNull();
  });

  it("backfill counts an unreadable meta file apart from threads without an owner and claims nothing for it", async () => {
    const dir = await storeDir();
    await persistGraph(dir, "good", YAML, spec(), { owner: { id: owner.id, org: owner.org } });
    await persistGraph(dir, "bad", YAML, spec(), { owner: { id: owner.id, org: owner.org } });
    await persistGraph(dir, "none", YAML, spec());
    await fs.writeFile(metaFile(dir, "bad"), '{"threadId":"bad","ow');
    const claims: string[] = [];
    const owners = { get: async () => null, claim: async (t: string, o: string) => (claims.push(t), { owner: o, created: true }) };
    const s = await startService(dir);
    (s as unknown as { threadOwners: unknown }).threadOwners = owners;
    expect(await s.backfillThreadOwners()).toEqual({ claimed: 1, existing: 0, conflicts: 0, skipped: 1, unreadable: 1 });
    expect(claims).toEqual(["good"]);
    const unreadable: string[] = [];
    const listed = await listPersistedGraphs(dir, { onUnreadable: (t) => unreadable.push(t) });
    expect(listed.map((m) => m.threadId).sort()).toEqual(["good", "none"]);
    expect(unreadable).toEqual(["bad"]);
  });
});
