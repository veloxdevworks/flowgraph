import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph, type GraphSpec, type ThreadRunCoordinator } from "@flowgraph/core";
import { openSqliteBackend, type SqliteBackend } from "./index.js";

const dirs: string[] = [], opened: SqliteBackend[] = [];
afterEach(() => { for (const b of opened.splice(0)) b.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function pair(retention?: false) {
  const dir = mkdtempSync(join(tmpdir(), "fg-claims-")); dirs.push(dir);
  const a = await openSqliteBackend({ path: join(dir, "db.sqlite"), ...(retention === undefined ? {} : { retention }) });
  const b = await openSqliteBackend({ path: join(dir, "db.sqlite"), ...(retention === undefined ? {} : { retention }) });
  opened.push(a, b);
  return { a, b, owner: a.checkpointer as unknown as ThreadRunCoordinator, other: b.checkpointer as unknown as ThreadRunCoordinator };
}
const spec = { metadata: { name: "claims" }, nodes: [{ id: "gate", type: "hitl", with: { mode: "approve", message: "yes?" } }], edges: [{ from: "START", to: "gate" }, { from: "gate", to: "END" }] } as unknown as GraphSpec;

describe("SQLite execution admission", () => {
  it.each([undefined, false] as const)("shares non-expiring claims across connections with retention %s", async retention => {
    const { a, owner, other } = await pair(retention);
    const claim = await owner.acquireThreadRun("t"); expect(claim).not.toBeNull();
    expect(await other.acquireThreadRun("t")).toBeNull();
    const independent = await other.acquireThreadRun("other"); expect(independent).not.toBeNull();
    await independent!.release();
    // Closing the owner's connection does not authorize stealing an unresolved claim.
    a.close(); opened.splice(opened.indexOf(a), 1);
    expect(await other.acquireThreadRun("t")).toBeNull();
  });
  it("releases only its own token and can admit a later invocation", async () => {
    const { b, owner, other } = await pair();
    const claim = await owner.acquireThreadRun("t"); await claim!.release();
    const next = await other.acquireThreadRun("t"); expect(next).not.toBeNull();
    expect(() => claim!.release()).toThrow(/claim changed/);
    expect(b.db.prepare("SELECT COUNT(*) AS n FROM fg_thread_run_claims").get()).toEqual({ n: 1 });
    await next!.release();
  });
  it("tracks default waiting/finished metadata but leaves unknown threads untouched", async () => {
    const { a } = await pair(); const g = await compileGraph(spec, { checkpointer: a.checkpointer });
    for (const method of [() => g.resume({ threadId: "missing", resume: true }), () => g.continueRun({ threadId: "missing" }), () => g.step({ threadId: "missing" })]) {
      await expect(method()).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    }
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM fg_checkpoint_threads").get()).toEqual({ n: 0 });
    expect((await g.run({ threadId: "t" })).status).toBe("interrupted");
    expect(a.db.prepare("SELECT status, deletable FROM fg_checkpoint_threads WHERE thread_id='t'").get()).toEqual({ status: "paused", deletable: 0 });
    expect((await g.resume({ threadId: "t", resume: true })).status).toBe("completed");
    expect(a.db.prepare("SELECT status, deletable FROM fg_checkpoint_threads WHERE thread_id='t'").get()).toEqual({ status: "finished", deletable: 0 });
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM fg_thread_run_claims").get()).toEqual({ n: 0 });
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
