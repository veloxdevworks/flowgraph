import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpTransport, registerFunction } from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";
import { parseGraphYaml } from "./graph-source.js";
import { createHttpServer } from "./http/app.js";
import { RunService } from "./run-service.js";
import type { ServerConfig } from "./types.js";

const dirs: string[] = [];
const services: RunService[] = [];
const servers: import("node:http").Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function boot() {
  const graphStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-dispatch-"));
  dirs.push(graphStoreDir);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, graphStoreDir, eventBufferSize: 200, authDisabled: true };
  const service = new RunService(config);
  await service.init();
  services.push(service);
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { service, target: { name: "worker", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } };
}

function spec(yaml: string): GraphSpec {
  const p = parseGraphYaml(yaml);
  if (!p.spec) throw new Error(JSON.stringify(p.diagnostics));
  return p.spec as GraphSpec;
}

registerFunction("pdAdd", async (input: unknown) => ({ n: Number((input as { n?: unknown })?.n ?? 0) + 1 }));
registerFunction("pdBoom", async () => {
  throw new Error("child exploded");
});

const twoStep = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pd-two-step }
state:
  channels:
    seed: { type: number }
    mid: { type: object }
    out: { type: object }
nodes:
  - { id: a, type: function, with: { fn: pdAdd, input: { n: "{{ state.seed }}" }, output: { to: mid } } }
  - { id: b, type: function, with: { fn: pdAdd, input: { n: "10" }, output: { to: out } } }
edges: [ { from: START, to: a }, { from: a, to: b }, { from: b, to: END } ]
`);

const failing = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pd-failing }
state: { channels: { out: { type: object } } }
nodes: [ { id: n, type: function, with: { fn: pdBoom, output: { to: out } } } ]
edges: [ { from: START, to: n }, { from: n, to: END } ]
`);

const slow = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pd-slow }
state: { channels: { out: { type: object } } }
nodes:
  - { id: w, type: wait, with: { duration: 30s } }
  - { id: n, type: function, with: { fn: pdAdd, output: { to: out } } }
edges: [ { from: START, to: w }, { from: w, to: n }, { from: n, to: END } ]
`);

const gate = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pd-gate }
state: { channels: { approval: { type: object } } }
nodes: [ { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } } ]
edges: [ { from: START, to: gate }, { from: gate, to: END } ]
runtime: { checkpoint: { enabled: true, backend: memory }, hitl: { onInterrupt: fail } }
`);

const tid = () => `parent-${randomUUID()}/node-x/1`;

async function drain(it: AsyncIterable<{ type: string; seq?: number }>) {
  const out: Array<{ type: string; seq?: number }> = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("direct transport dispatch / attach / cancel (e2e)", () => {
  it("dispatches, streams ordered events to run.end, and returns final state", async () => {
    const { target } = await boot();
    const t = createHttpTransport();
    const childThreadId = tid();
    expect(await t.dispatch(target, { childThreadId, spec: twoStep, input: { seed: 4 }, label: "child" })).toEqual({ status: "started" });
    const a = t.attach(target, childThreadId);
    const events = await drain(a.events);
    const seqs = events.map((e) => e.seq!).filter((s) => s >= 0);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events[0]!.type).toBe("run.start");
    expect(events.at(-1)!.type).toBe("run.end");
    expect(events.filter((e) => e.type === "node.end").length).toBeGreaterThanOrEqual(2);
    const out = await a.result;
    expect(out.status).toBe("completed");
    expect(out.state).toMatchObject({ seed: 4, mid: { n: 5 }, out: { n: 11 } });
    expect(Object.keys(out.state!).filter((k) => k.startsWith("__"))).toEqual([]);
  });

  it("a second dispatch of the same child id is 'exists', and attach still returns the same state", async () => {
    const { target, service } = await boot();
    const t = createHttpTransport();
    const childThreadId = tid();
    await t.dispatch(target, { childThreadId, spec: twoStep, input: { seed: 1 } });
    const first = await t.attach(target, childThreadId).result;
    // the status leaves "running" just after the terminal event is pushed
    for (let i = 0; i < 100 && service.registry.hasLiveRun(childThreadId); i++) await new Promise((r) => setTimeout(r, 10));
    const again = await t.dispatch(target, { childThreadId, spec: twoStep, input: { seed: 99 } });
    expect(again).toMatchObject({ status: "exists", runStatus: "completed", active: false });
    const a2 = t.attach(target, childThreadId);
    const replay = await drain(a2.events);
    expect(replay.at(-1)!.type).toBe("run.end");
    expect((await a2.result).state).toEqual(first.state);
    expect(first.state).toMatchObject({ seed: 1, out: { n: 11 } });
  });

  it("attach with afterSeq resumes without repeating events", async () => {
    const { target } = await boot();
    const t = createHttpTransport();
    const childThreadId = tid();
    await t.dispatch(target, { childThreadId, spec: twoStep, input: { seed: 1 } });
    const all = await drain(t.attach(target, childThreadId).events);
    const mid = all[Math.floor(all.length / 2)]!.seq!;
    const rest = await drain(t.attach(target, childThreadId, { afterSeq: mid }).events);
    expect(rest.map((e) => e.seq)).toEqual(all.filter((e) => e.seq! > mid).map((e) => e.seq));
  });

  it("cancels a running child: outcome cancelled, and cancel is idempotent", async () => {
    const { target } = await boot();
    const t = createHttpTransport();
    const childThreadId = tid();
    await t.dispatch(target, { childThreadId, spec: slow });
    const a = t.attach(target, childThreadId);
    // wait until the run is really executing
    const it = a.events[Symbol.asyncIterator]();
    for (;;) {
      const n = await it.next();
      if (n.done || n.value.type === "node.start") break;
    }
    await t.cancel(target, childThreadId);
    const out = await a.result;
    expect(out.status).toBe("cancelled");
    await t.cancel(target, childThreadId);
    await t.cancel(target, `never-dispatched-${randomUUID()}`);
    expect((await t.attach(target, childThreadId).result).status).toBe("cancelled");
  });

  it("reports a failing child as error with its message", async () => {
    const { target } = await boot();
    const t = createHttpTransport();
    const childThreadId = tid();
    await t.dispatch(target, { childThreadId, spec: failing });
    const out = await t.attach(target, childThreadId).result;
    expect(out.status).toBe("error");
    expect(out.error?.message).toMatch(/child exploded/);
    // a failed thread may be dispatched again
    expect(await t.dispatch(target, { childThreadId, spec: failing })).toEqual({ status: "started" });
  });

  it("surfaces a gate as interrupted, and resume forwards to the worker", async () => {
    const { target } = await boot();
    const t = createHttpTransport();
    const childThreadId = tid();
    await t.dispatch(target, { childThreadId, spec: gate });
    const first = await t.attach(target, childThreadId).result;
    expect(first.status).toBe("interrupted");
    expect(first.interrupts?.length).toBeGreaterThan(0);
    await t.resume(target, childThreadId, { approved: true });
    const next = await t.attach(target, childThreadId, { afterSeq: first.lastSeq! }).result;
    expect(next.status).toBe("completed");
    expect(next.state).toHaveProperty("approval");
  });

  it("errors from the worker name the target", async () => {
    const { target } = await boot();
    const t = createHttpTransport({ reconnectDelayMs: 1 });
    await expect(t.dispatch(target, { childThreadId: "", spec: twoStep })).rejects.toThrow(/"worker".*400.*threadId is required/);
    await expect(t.attach(target, `missing-${randomUUID()}`).result).rejects.toThrow(/"worker".*404/);
  });
});
