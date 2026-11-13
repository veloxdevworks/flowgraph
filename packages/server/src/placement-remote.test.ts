/**
 * Coordinator in the test process (`compileGraph` + `runGraph` with the HTTP transport) running placed
 * nodes on an in-process worker server (ADR-0020 §8).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { compileGraph, createHttpTransport, registerFunction, type FlowgraphEvent } from "@flowgraph/core";
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

async function worker() {
  const graphStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-remote-"));
  dirs.push(graphStoreDir);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    graphStoreDir,
    eventBufferSize: 500,
    authDisabled: true,
    workerLabels: { "app:test": {} },
  };
  const service = new RunService(config);
  await service.init();
  services.push(service);
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { service, topology: { targets: { worker: { url } } } };
}

function spec(yaml: string): GraphSpec {
  const p = parseGraphYaml(yaml);
  if (!p.spec) throw new Error(JSON.stringify(p.diagnostics));
  return p.spec as GraphSpec;
}

registerFunction("prInc", async (input: unknown) => ({ n: Number((input as { n?: unknown })?.n ?? 0) + 1 }));
registerFunction("prBoom", async () => {
  throw new Error("child exploded");
});

const LOCAL = ["os:macos"]; // does not include app:test, so the placed nodes must go to the worker

const placedSubgraph = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pr-parent }
state:
  channels:
    seed: { type: number, default: 4 }
    result: { type: object }
nodes:
  - id: place
    type: subgraph
    runsOn: [app:test]
    spec:
      apiVersion: flowgraph/v1
      kind: Graph
      metadata: { name: pr-child }
      state:
        channels:
          start: { type: number }
          bumped: { type: object }
      nodes:
        - { id: inc, type: function, with: { fn: prInc, input: { n: "{{ state.start }}" }, output: { to: bumped } } }
      edges: [ { from: START, to: inc }, { from: inc, to: END } ]
    with:
      stateMap:
        in: { start: seed }
        out: { result: bumped }
edges: [ { from: START, to: place }, { from: place, to: END } ]
`);

const placedNode = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pr-node }
state:
  channels:
    seed: { type: number, default: 9 }
    bumped: { type: object }
nodes:
  - id: inc
    type: function
    runsOn: [app:test]
    input: { x: "{{ state.seed }}" }
    with: { fn: prInc, input: { n: "{{ input.x }}" }, output: { to: bumped } }
edges: [ { from: START, to: inc }, { from: inc, to: END } ]
`);

const placedFailing = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pr-fail }
state: { channels: { out: { type: object } } }
nodes:
  - id: boom
    type: function
    runsOn: [app:test]
    with: { fn: prBoom, output: { to: out } }
edges: [ { from: START, to: boom }, { from: boom, to: END } ]
`);

const placedSlow = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pr-slow }
state: { channels: { out: { type: object } } }
nodes:
  - id: slow
    type: subgraph
    runsOn: [app:test]
    spec:
      apiVersion: flowgraph/v1
      kind: Graph
      metadata: { name: pr-slow-child }
      state: { channels: { out: { type: object } } }
      nodes:
        - { id: w, type: wait, with: { duration: 30s } }
      edges: [ { from: START, to: w }, { from: w, to: END } ]
    with: { stateMap: { out: { out: out } } }
edges: [ { from: START, to: slow }, { from: slow, to: END } ]
`);

async function coordinator(graph: GraphSpec, topology: { targets: Record<string, { url: string }> }) {
  return compileGraph(graph, { placement: { localLabels: LOCAL, topology, transport: createHttpTransport({ reconnectDelayMs: 5 }) } });
}

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
}

describe("placed nodes run on a worker server (e2e)", () => {
  it("runs a placed subgraph on the worker and lands stateMap.out in parent state", async () => {
    const { service, topology } = await worker();
    const compiled = await coordinator(placedSubgraph, topology);
    const threadId = `coord-${randomUUID()}`;
    const events: FlowgraphEvent[] = [];
    const r = await compiled.run({ threadId, sinks: [(e) => void events.push(e)] });
    expect(r.status).toBe("completed");
    expect(r.state.result).toEqual({ n: 5 });
    const childId = `${threadId}/place/1`;
    // the worker records the final status just after the terminal event
    await until(() => service.registry.get(childId)?.status === "completed");
    const placement = { target: "worker", childThreadId: childId };
    expect(events.find((e) => e.type === "node.start" && e.scope.nodeId === "place")?.scope.placement).toEqual(placement);
    expect(events.find((e) => e.type === "node.end" && e.scope.nodeId === "place")?.scope.placement).toEqual(placement);
    const nested = events.filter((e) => e.scope.parentSpanId === "place");
    expect(nested.some((e) => e.type === "node.end" && e.scope.nodeId === "inc")).toBe(true);
    for (const e of nested) expect(e.scope.placement).toEqual(placement);
  });

  it("runs a placed non-subgraph node and writes its result like the in-process node", async () => {
    const { service, topology } = await worker();
    const compiled = await coordinator(placedNode, topology);
    const threadId = `coord-${randomUUID()}`;
    const r = await compiled.run({ threadId });
    expect(r.status).toBe("completed");
    expect(r.state.bumped).toEqual({ n: 10 });
    expect((r.state.outputs as Record<string, unknown>).inc).toEqual({ n: 10 });
    await until(() => service.registry.get(`${threadId}/inc/1`)?.status === "completed");

    const local = await compileGraph(placedNode, { placement: { localLabels: ["app:test"] } });
    const lr = await local.run({ threadId: `local-${randomUUID()}` });
    expect(r.state.bumped).toEqual(lr.state.bumped);
    expect(r.state.outputs).toEqual(lr.state.outputs);
  });

  it("surfaces a failing child as REMOTE_NODE_FAILED with its message", async () => {
    const { topology } = await worker();
    const compiled = await coordinator(placedFailing, topology);
    const r = await compiled.run({ threadId: `coord-${randomUUID()}` });
    expect(r.status).toBe("error");
    expect((r.error as { code?: string }).code).toBe("REMOTE_NODE_FAILED");
    expect(r.error?.message).toContain('target "worker"');
    expect(r.error?.message).toContain("child exploded");
  });

  it("aborting the coordinator run cancels the child on the worker", async () => {
    const { service, topology } = await worker();
    const compiled = await coordinator(placedSlow, topology);
    const threadId = `coord-${randomUUID()}`;
    const childId = `${threadId}/slow/1`;
    const ac = new AbortController();
    const running = compiled.run({ threadId, signal: ac.signal });
    await until(() => service.registry.get(childId)?.status === "running");
    ac.abort();
    const r = await running;
    expect(r.status).toBe("aborted");
    await until(() => service.registry.get(childId)?.status === "cancelled");
  });
});
