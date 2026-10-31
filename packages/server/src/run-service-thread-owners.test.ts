import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RunService } from "./run-service.js";
import type { Principal, ServerAuthConfig } from "./identity.js";
import type { ServerConfig } from "./types.js";

const PG_URL = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

const OIDC: ServerAuthConfig = {
  mode: "oidc",
  explicit: true,
  insecureDev: false,
  oidc: {
    issuer: "https://id.example.com",
    audience: ["api"],
    algorithms: ["RS256"],
    clockToleranceSec: 60,
    claims: { org: "org_id", roles: "roles", teams: "groups", displayName: ["name"] },
    trust: { roles: [], teams: [] },
    defaultProject: "local",
  },
};
const who = (subject: string): Principal => ({
  id: `https://id.example.com|${subject}`,
  subject,
  issuer: "https://id.example.com",
  org: "acme",
  project: "web",
  teams: [],
  roles: [],
  trusted: false,
  via: "oidc",
});
const alice = who("alice");
const bob = who("bob");

const gate = (name: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    secret: { type: string }
    approval: { type: object }
nodes:
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
`;

const services: RunService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "fg-owners-"));
  dirs.push(d);
  return d;
}

async function service(dir: string, extra: Partial<ServerConfig> = {}): Promise<RunService> {
  const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100, auth: OIDC, ...extra });
  await s.init();
  services.push(s);
  return s;
}

async function settle(s: RunService, t: string, want: string[]): Promise<string | undefined> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const st = s.registry.get(t)?.status;
    if (st && want.includes(st)) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  return s.registry.get(t)?.status;
}

const notOwned = { status: 403, code: "THREAD_NOT_OWNED" };

/** Remove every graph-store file for a thread (meta, yaml, journal). */
async function wipeThread(dir: string, threadId: string): Promise<void> {
  for (const f of await fs.readdir(dir)) if (f.startsWith(`${threadId}.`)) await fs.rm(path.join(dir, f), { recursive: true, force: true });
}

/** Every call bob could use to reach alice's thread. */
async function expectBobRefused(s: RunService, t: string): Promise<void> {
  await expect(s.startRun({ threadId: t, yaml: gate(`bob-${randomUUID().slice(0, 8)}`), input: {} }, bob)).rejects.toMatchObject(notOwned);
  await expect(s.getState(t, undefined, bob)).rejects.toMatchObject(notOwned);
  await expect(s.getHistory(t, undefined, bob)).rejects.toMatchObject(notOwned);
  await expect(s.resumeRun({ threadId: t, resume: { approved: true }, yaml: gate("bob-resume") }, bob)).rejects.toMatchObject(notOwned);
  await expect(s.getRun(t, bob)).rejects.toMatchObject(notOwned);
  await expect(s.authorizeEvents(t, bob)).rejects.toMatchObject(notOwned);
}

describe.skipIf(!PG_URL)("thread ownership shared through Postgres", () => {
  it("a second server with its own graph store refuses another user's thread, and serves its owner", async () => {
    // Checkpoints in Postgres, no memory backend: the setup the hijack used.
    const a = await service(await tmp(), { databaseUrl: PG_URL! });
    const b = await service(await tmp(), { databaseUrl: PG_URL! });
    const t = `hj-${randomUUID()}`;
    const g = gate(`alice-${randomUUID().slice(0, 8)}`);
    await a.startRun({ threadId: t, yaml: g, input: { secret: "alice-private-123" } }, alice);
    expect(await settle(a, t, ["interrupted", "error"])).toBe("interrupted");

    await expectBobRefused(a, t);
    await expectBobRefused(b, t);
    // Nothing bob tried reached alice's state.
    // The owner reads it from either server (B has no copy of the graph).
    const st = await b.getState(t, g, alice);
    expect(JSON.stringify(st)).toContain("alice-private-123");
    expect((await a.getState(t, undefined, alice)).state?.values).toMatchObject({ secret: "alice-private-123" });
  });

  it("refuses another user after the graph store is wiped and the server restarts", async () => {
    const dir = await tmp();
    const a = await service(dir, { databaseUrl: PG_URL! });
    const t = `wipe-${randomUUID()}`;
    const g = gate(`alice-${randomUUID().slice(0, 8)}`);
    await a.startRun({ threadId: t, yaml: g, input: { secret: "s3" } }, alice);
    expect(await settle(a, t, ["interrupted", "error"])).toBe("interrupted");
    await a.close();
    await wipeThread(dir, t);
    const a2 = await service(dir, { databaseUrl: PG_URL! });
    await expectBobRefused(a2, t);
    expect((await a2.getState(t, g, alice)).state?.values).toMatchObject({ secret: "s3" });
  });

  it("refuses a thread with saved checkpoints but no recorded owner, for everyone", async () => {
    const dir = await tmp();
    const a = await service(dir, { databaseUrl: PG_URL! });
    const t = `legacy-${randomUUID()}`;
    await a.startRun({ threadId: t, yaml: gate(`alice-${randomUUID().slice(0, 8)}`), input: {} }, alice);
    expect(await settle(a, t, ["interrupted", "error"])).toBe("interrupted");
    await a.close();
    // As if the thread were stored before owners were recorded.
    const { openPostgresBackend } = await import("@flowgraph/checkpoint-postgres");
    const raw = await openPostgresBackend(PG_URL!);
    await raw.pool.query(`DELETE FROM public.fg_thread_owners WHERE thread_id = $1`, [t]);
    await raw.close();
    await wipeThread(dir, t);
    const a2 = await service(dir, { databaseUrl: PG_URL! });
    for (const p of [alice, bob]) {
      await expect(a2.startRun({ threadId: t, yaml: gate("legacy-take"), input: {} }, p)).rejects.toMatchObject({
        ...notOwned,
        message: expect.stringMatching(/saved state but no recorded owner/),
      });
      await expect(a2.getState(t, undefined, p)).rejects.toMatchObject(notOwned);
    }
  });

  it("startup copies owners from pre-upgrade meta files so other replicas serve the owner", async () => {
    const dir = await tmp();
    const a = await service(dir, { databaseUrl: PG_URL! });
    const t = `backfill-${randomUUID()}`;
    const g = gate(`alice-${randomUUID().slice(0, 8)}`);
    await a.startRun({ threadId: t, yaml: g, input: { secret: "bf1" } }, alice);
    expect(await settle(a, t, ["interrupted", "error"])).toBe("interrupted");
    await a.close();
    // As if the thread were started before owners were kept with the checkpoints.
    const { openPostgresBackend } = await import("@flowgraph/checkpoint-postgres");
    const raw = await openPostgresBackend(PG_URL!);
    await raw.pool.query(`DELETE FROM public.fg_thread_owners WHERE thread_id = $1`, [t]);
    await raw.close();
    // Restarting the replica that has the meta file records the owner...
    const a2 = await service(dir, { databaseUrl: PG_URL! });
    // ...so a replica without it serves alice and refuses bob.
    const b = await service(await tmp(), { databaseUrl: PG_URL! });
    expect((await b.getState(t, g, alice)).state?.values).toMatchObject({ secret: "bf1" });
    await expectBobRefused(b, t);
    // Running it again changes nothing.
    const again = await a2.backfillThreadOwners();
    expect(again.claimed).toBe(0);
    expect(again.existing).toBeGreaterThanOrEqual(1);
  });

  it("concurrent starts of one new thread id on two servers give it to exactly one user", async () => {
    const a = await service(await tmp(), { databaseUrl: PG_URL! });
    const b = await service(await tmp(), { databaseUrl: PG_URL! });
    const t = `race-${randomUUID()}`;
    const results = await Promise.allSettled([
      a.startRun({ threadId: t, yaml: gate(`ra-${randomUUID().slice(0, 8)}`), input: {} }, alice),
      b.startRun({ threadId: t, yaml: gate(`rb-${randomUUID().slice(0, 8)}`), input: {} }, bob),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject(notOwned);
    const winner = results[0]!.status === "fulfilled" ? a : b;
    expect(await settle(winner, t, ["interrupted", "error"])).toBe("interrupted");
  });
});

describe("thread ownership without Postgres", () => {
  it("sqlite memory keeps owners in its file across a restart with a wiped graph store", async () => {
    const dir = await tmp();
    const memory = { backend: "sqlite" as const };
    const s = await service(dir, { memory });
    const t = `sq-${randomUUID()}`;
    await s.startRun({ threadId: t, yaml: gate(`alice-${randomUUID().slice(0, 8)}`), input: {} }, alice);
    expect(await settle(s, t, ["interrupted", "error"])).toBe("interrupted");
    await s.close();
    await wipeThread(dir, t);
    const s2 = await service(dir, { memory });
    await expect(s2.startRun({ threadId: t, yaml: gate("bob-take"), input: {} }, bob)).rejects.toMatchObject(notOwned);
    await expect(s2.getState(t, undefined, bob)).rejects.toMatchObject(notOwned);
    // The owner can start the id again.
    await expect(s2.startRun({ threadId: t, yaml: gate(`alice-${randomUUID().slice(0, 8)}`), input: {} }, alice)).resolves.toMatchObject({ status: "started" });
    expect(await settle(s2, t, ["interrupted", "error"])).toBe("interrupted");
  });

  it("an in-memory server refuses another user after the thread's graph-store files are deleted", async () => {
    const dir = await tmp();
    const s = await service(dir);
    const t = `mem-${randomUUID()}`;
    const g = gate(`alice-${randomUUID().slice(0, 8)}`);
    await s.startRun({ threadId: t, yaml: g, input: { secret: "m1" } }, alice);
    expect(await settle(s, t, ["interrupted", "error"])).toBe("interrupted");
    await wipeThread(dir, t);
    s.registry.remove(t);
    await expectBobRefused(s, t);
    expect((await s.getState(t, g, alice)).state?.values).toMatchObject({ secret: "m1" });
  });

  it("backfills owners from meta files idempotently and leaves conflicting owners alone", async () => {
    const dir = await tmp();
    const s = await service(dir);
    const t = `bfm-${randomUUID()}`;
    await s.startRun({ threadId: t, yaml: gate(`alice-${randomUUID().slice(0, 8)}`), input: {} }, alice);
    expect(await settle(s, t, ["interrupted", "error"])).toBe("interrupted");
    const { createInMemoryThreadOwnerRegistry } = await import("@flowgraph/core");
    const fresh = createInMemoryThreadOwnerRegistry();
    (s as unknown as { threadOwners: unknown }).threadOwners = fresh;
    expect(await s.backfillThreadOwners()).toMatchObject({ claimed: 1, existing: 0, conflicts: 0 });
    expect((await fresh.get(t))?.owner).toBe(alice.id);
    expect(await s.backfillThreadOwners()).toMatchObject({ claimed: 0, existing: 1, conflicts: 0 });
    const other = createInMemoryThreadOwnerRegistry();
    await other.claim(t, bob.id, "acme");
    (s as unknown as { threadOwners: unknown }).threadOwners = other;
    expect(await s.backfillThreadOwners()).toMatchObject({ claimed: 0, conflicts: 1 });
    expect((await other.get(t))?.owner).toBe(bob.id);
  });

  it("refuses when the owner cannot be looked up", async () => {
    const s = await service(await tmp());
    await s.listRuns(alice);
    const down = async () => {
      throw new Error("connection refused");
    };
    (s as unknown as { threadOwners: unknown }).threadOwners = { get: down, claim: down };
    await expect(s.startRun({ threadId: `down-${randomUUID()}`, yaml: gate("down"), input: {} }, alice)).rejects.toMatchObject({
      status: 503,
      code: "THREAD_OWNER_UNAVAILABLE",
    });
    await expect(s.getState("anything", undefined, alice)).rejects.toMatchObject({ status: 503, code: "THREAD_OWNER_UNAVAILABLE" });
  });

  it("does not reveal another user's thread through an id that collides on disk", async () => {
    const s = await service(await tmp());
    await s.startRun({ threadId: "team/plan", yaml: gate(`alice-${randomUUID().slice(0, 8)}`), input: {} }, alice);
    expect(await settle(s, "team/plan", ["interrupted", "error"])).toBe("interrupted");
    const err = await s.startRun({ threadId: "team_plan", yaml: gate("bob-collide"), input: {} }, bob).catch((e: unknown) => e);
    expect(err).toMatchObject(notOwned);
    expect(String((err as Error).message)).not.toContain("team/plan");
    // Its owner is told about the collision.
    await expect(s.startRun({ threadId: "team_plan", yaml: gate("alice-collide"), input: {} }, alice)).rejects.toMatchObject({ status: 409, code: "THREAD_ID_CONFLICT" });
  });
});
