import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { defaultServerConfig } from "../types.js";
import { RunService } from "../run-service.js";
import { SessionRegistry } from "../session-registry.js";
import { createHttpServer } from "./app.js";

const TOKEN = "agentcore-test-token";

const HITL_YAML = [
  "apiVersion: flowgraph/v1",
  "kind: Graph",
  "metadata: { name: agentcore-hitl }",
  "state: { channels: { approval: { type: object } } }",
  "nodes:",
  "  - { id: gate, type: hitl, with: { mode: approve, message: ok, output: { to: approval } } }",
  "edges: [{ from: START, to: gate }, { from: gate, to: END }]",
  "runtime: { checkpoint: { enabled: true, backend: memory }, hitl: { onInterrupt: fail } }",
].join("\n");

interface Harness {
  base: string;
  service: RunService;
  server: Server;
  dir: string;
}

const open: Harness[] = [];

async function startServer(env: Record<string, string>): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-agentcore-"));
  const config = defaultServerConfig({ FLOWGRAPH_GRAPH_STORE: dir, FLOWGRAPH_AUTH_TOKEN: TOKEN, ...env });
  const service = new RunService(config);
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const h = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, service, server, dir };
  open.push(h);
  return h;
}

afterEach(async () => {
  for (const h of open.splice(0)) {
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
    await h.service.close();
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

function invoke(base: string, body: unknown, authorization?: string): Promise<Response> {
  return fetch(`${base}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
    // A stream that never ends fails the test instead of hanging it.
    signal: AbortSignal.timeout(10_000),
  });
}

function sseEvents(text: string): Array<{ type?: string; runId?: string }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type?: string; runId?: string });
}

describe("/invocations auth", () => {
  it("takes REST auth when the server is not on AgentCore", async () => {
    const { base } = await startServer({});
    expect((await invoke(base, { action: "nope" })).status).toBe(401);
    expect((await invoke(base, { action: "nope" }, "Bearer wrong")).status).toBe(401);
    expect((await invoke(base, { action: "nope" }, `Bearer ${TOKEN}`)).status).toBe(400);
    expect((await fetch(`${base}/ping`)).status).toBe(200);
  });

  it("trusts the AgentCore edge with FLOWGRAPH_AGENTCORE=1", async () => {
    const { base } = await startServer({ FLOWGRAPH_AGENTCORE: "1" });
    const res = await invoke(base, { action: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Unknown action") });
    // REST still needs the token.
    expect((await fetch(`${base}/runs`)).status).toBe(401);
  });
});

describe("/invocations streams", () => {
  it("ends an events stream for a thread with no run in this process, and stays Healthy", async () => {
    const { base, service } = await startServer({ FLOWGRAPH_AGENTCORE: "1" });
    const res = await invoke(base, { action: "events", threadId: "never-ran-here" });
    expect(res.status).toBe(200);
    expect(sseEvents(await res.text())).toEqual([]);
    expect(service.registry.hasActiveWork()).toBe(false);
    expect(await (await fetch(`${base}/ping`)).json()).toMatchObject({ status: "Healthy" });
  });

  it("streams a started run to its terminal event, then replays it from afterSeq", async () => {
    const { base } = await startServer({ FLOWGRAPH_AGENTCORE: "1" });
    const started = await invoke(base, { action: "start", threadId: "ac-t1", yaml: HITL_YAML });
    expect(started.status).toBe(200);
    const events = sseEvents(await started.text());
    expect(events.at(-1)?.type).toBe("interrupt.raised");
    const runIds = new Set(events.map((e) => e.runId));
    expect(runIds.size).toBe(1);

    const replay = await invoke(base, { action: "events", threadId: "ac-t1", afterSeq: 0 });
    expect(sseEvents(await replay.text()).at(-1)?.type).toBe("interrupt.raised");
    // The run is marked finished once its meta file is written, just after the event.
    await expect.poll(async () => ((await (await fetch(`${base}/ping`)).json()) as { status: string }).status).toBe("Healthy");

    // On resume the gate runs again and emits a node-level interrupt.raised before it
    // gets its answer; the stream must carry on to run.end, not stop there.
    const resumed = await invoke(base, { action: "resume", threadId: "ac-t1", resume: { approved: true } });
    expect(resumed.status).toBe(200);
    const after = sseEvents(await resumed.text());
    expect(after.map((e) => e.type)).toContain("interrupt.raised");
    expect(after.at(-1)?.type).toBe("run.end");
  });
});

describe("SessionRegistry", () => {
  it("does not count a cold-subscribe placeholder as active work", () => {
    const registry = new SessionRegistry();
    const unsub = registry.subscribe("cold", () => {});
    expect(registry.get("cold")).toBeDefined();
    expect(registry.hasActiveWork()).toBe(false);
    expect(registry.activeCount()).toBe(0);
    expect(registry.hasLiveRun("cold")).toBe(false);
    unsub();

    registry.create({ threadId: "live", runId: "pending", graphName: "g", yaml: "" });
    expect(registry.hasActiveWork()).toBe(true);
    expect(registry.activeCount()).toBe(1);
    expect(registry.hasLiveRun("live")).toBe(true);
    registry.setStatus("live", "completed");
    expect(registry.hasLiveRun("live")).toBe(false);
  });
});
