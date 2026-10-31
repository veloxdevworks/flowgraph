import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
