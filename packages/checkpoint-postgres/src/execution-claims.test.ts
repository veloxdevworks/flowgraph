import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { compileGraph, type GraphSpec, type ThreadRunCoordinator } from "@flowgraph/core";
import { openPostgresBackend, type PostgresBackend } from "./index.js";

const DB = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];
const opened: PostgresBackend[] = [], pools: pg.Pool[] = [], schemas: string[] = [];
afterEach(async () => {
  for (const b of opened.splice(0)) await b.close();
  if (DB) { const admin = new pg.Pool({ connectionString: DB }); try { for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA "${s}" CASCADE`); } finally { await admin.end(); } }
  for (const p of pools.splice(0)) await p.end();
});
async function pair(retention?: false) {
  const schema = `fg_claim_${randomUUID().replaceAll("-", "")}`; schemas.push(schema);
  // Admission must never hold a dedicated pool slot: max=1 is supported.
  const pool = new pg.Pool({ connectionString: DB, max: 1 }); pools.push(pool);
  const a = await openPostgresBackend({ pool, schema, ...(retention === undefined ? {} : { retention }) });
  const b = await openPostgresBackend({ connectionString: DB!, schema, ...(retention === undefined ? {} : { retention }), poolConfig: { max: 1 } });
  opened.push(a, b);
  return { a, b, schema, owner: a.checkpointer as unknown as ThreadRunCoordinator, other: b.checkpointer as unknown as ThreadRunCoordinator };
}
const spec = { metadata: { name: "claims" }, nodes: [{ id: "gate", type: "hitl", with: { mode: "approve", message: "yes?" } }], edges: [{ from: "START", to: "gate" }, { from: "gate", to: "END" }] } as unknown as GraphSpec;

describe.skipIf(!DB)("PostgreSQL execution admission", () => {
  it.each([undefined, false] as const)("shares durable claims with retention %s", async retention => {
    const { a, owner, other } = await pair(retention);
    const claim = await owner.acquireThreadRun("t"); expect(claim).not.toBeNull();
    expect(await other.acquireThreadRun("t")).toBeNull();
    const independent = await other.acquireThreadRun("other"); expect(independent).not.toBeNull(); await independent!.release();
    await a.pool.end(); pools.splice(pools.indexOf(a.pool), 1);
    expect(await other.acquireThreadRun("t")).toBeNull();
  });
  it("releases only its own token and admits a later invocation", async () => {
    const { owner, other } = await pair();
    const claim = await owner.acquireThreadRun("t"); await claim!.release();
    const next = await other.acquireThreadRun("t"); expect(next).not.toBeNull();
    await expect(claim!.release()).rejects.toThrow(/claim changed/);
    expect(await owner.acquireThreadRun("t")).toBeNull(); await next!.release();
  });
  it("tracks default waiting/finished metadata and refuses unknown threads without writes", async () => {
    const { a, schema } = await pair(); const g = await compileGraph(spec, { checkpointer: a.checkpointer });
    for (const method of [() => g.resume({ threadId: "missing", resume: true }), () => g.continueRun({ threadId: "missing" }), () => g.step({ threadId: "missing" })]) await expect(method()).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    expect((await a.pool.query(`SELECT COUNT(*) AS n FROM "${schema}".fg_checkpoint_threads`)).rows[0].n).toBe("0");
    expect((await g.run({ threadId: "t" })).status).toBe("interrupted");
    expect((await a.pool.query(`SELECT status, deletable FROM "${schema}".fg_checkpoint_threads WHERE thread_id='t'`)).rows[0]).toEqual({ status: "paused", deletable: 0 });
    expect((await g.resume({ threadId: "t", resume: true })).status).toBe("completed");
    expect((await a.pool.query(`SELECT status, deletable FROM "${schema}".fg_checkpoint_threads WHERE thread_id='t'`)).rows[0]).toEqual({ status: "finished", deletable: 0 });
  });
  it("records owner identity and exposes token-checked explicit recovery", async () => {
    const { owner, other } = await pair();
    const identity = { host: "quiesced-worker", pid: 424242, invocationId: "request-123", runId: "run-123" };
    expect(await owner.acquireThreadRun("recover", identity)).not.toBeNull();
    const info = await other.inspectThreadRun!("recover");
    expect(info).toMatchObject({ threadId: "recover", owner: identity, token: expect.any(String) });
    expect(await other.releaseThreadRun!("recover", "wrong-token")).toBe(false);
    expect(await other.acquireThreadRun("recover")).toBeNull();
    expect(await other.releaseThreadRun!("recover", info!.token)).toBe(true);
    const next = await other.acquireThreadRun("recover"); expect(next).not.toBeNull(); await next!.release();
  });

});
