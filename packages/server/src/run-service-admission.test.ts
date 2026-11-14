import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFunction } from "@flowgraph/core";
import { RunService } from "./run-service.js";

const dirs: string[] = [], services: RunService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function pair() {
  const dir = await mkdtemp(join(tmpdir(), "fg-service-admission-")); dirs.push(dir);
  const open = async () => { const service = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100, memory: { backend: "sqlite", identity: { org: "acme", project: "local" } } }); await service.init(); services.push(service); return service; };
  return { a: await open(), b: await open() };
}
const yaml = JSON.stringify({ apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "admission" }, nodes: [{ id: "gate", type: "hitl", with: { mode: "approve", message: "yes?" } }, { id: "work", type: "function", with: { fn: "qaServerAdmission" } }], edges: [{ from: "START", to: "gate" }, { from: "gate", to: "work" }, { from: "work", to: "END" }] });
it("rejects same-service and replica competitors before altering the owner's stream, status or controllers", async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let effects = 0;
  registerFunction("qaServerAdmission", async () => { effects++; entered(); await hold; return "done"; });
  const { a, b } = await pair();
  await a.startRun({ threadId: "t", yaml });
  await expect.poll(() => a.registry.get("t")?.status).toBe("interrupted");
  const events: string[] = []; const unsubscribe = a.registry.subscribe("t", event => { events.push(String(event.type)); });
  await a.resumeRun({ threadId: "t", resume: true }); await ready;
  const { abort, pause } = a.registry.get("t")!;
  try {
    await expect(a.resumeRun({ threadId: "t", resume: true })).rejects.toMatchObject({ status: 409, code: "THREAD_BUSY" });
    await expect(b.resumeRun({ threadId: "t", resume: true })).rejects.toMatchObject({ status: 409, code: "THREAD_BUSY" });
    await expect(a.continueRun("t")).rejects.toMatchObject({ status: 409, code: "THREAD_BUSY" });
    expect(a.registry.get("t")).toMatchObject({ status: "running", abort, pause });
    expect(a.registry.get("t")!.abort).toBe(abort); expect(a.registry.get("t")!.pause).toBe(pause);
    expect(b.registry.get("t")).toBeUndefined(); expect(events).not.toContain("run.error");
  } finally { release(); }
  await expect.poll(() => a.registry.get("t")?.status).toBe("completed");
  expect(effects).toBe(1); unsubscribe();
});
it("maps invalid/finished/unknown continuations before replacing an interrupted session", async () => {
  registerFunction("qaServerAdmission", () => "done");
  const { a } = await pair();
  await a.startRun({ threadId: "t", yaml });
  await expect.poll(() => a.registry.get("t")?.status).toBe("interrupted");
  const { abort, pause } = a.registry.get("t")!;
  await expect(a.continueRun("t")).rejects.toMatchObject({ status: 400, code: "RESUME_VALUE_REQUIRED" });
  expect(a.registry.get("t")).toMatchObject({ status: "interrupted", abort, pause });
  await a.resumeRun({ threadId: "t", resume: true });
  await expect.poll(() => a.registry.get("t")?.status).toBe("completed");
  await expect(a.resumeRun({ threadId: "t", resume: true })).rejects.toMatchObject({ status: 409, code: "THREAD_NOT_WAITING" });
  expect(a.registry.get("t")?.status).toBe("completed");
  await expect(a.resumeRun({ threadId: "unknown", resume: true })).rejects.toMatchObject({ status: 404, code: "THREAD_NOT_FOUND" });
});


it("binds a cold replica's new session to the controllers actually used by its prepared run", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let signal: AbortSignal | undefined;
  registerFunction("qaServerAdmission", async (_input, ctx) => { signal = ctx.signal; entered(); await hold; return "done"; });
  const { a, b } = await pair();
  await a.startRun({ threadId: "cold", yaml });
  await expect.poll(() => a.registry.get("cold")?.status).toBe("interrupted");
  await b.resumeRun({ threadId: "cold", resume: true }); await ready;
  try { expect(b.registry.get("cold")!.abort.signal).toBe(signal); }
  finally { release(); }
  await expect.poll(() => b.registry.get("cold")?.status).toBe("completed");
});
