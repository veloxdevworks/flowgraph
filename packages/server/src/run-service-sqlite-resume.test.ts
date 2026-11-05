import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunService } from "./run-service.js";
import type { ServerConfig } from "./types.js";

const HITL_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: sqlite-hitl
state:
  channels:
    approval: { type: object }
nodes:
  - id: gate
    type: hitl
    with:
      mode: approve
      message: "Approve?"
      output: { to: approval }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
  hitl:
    onInterrupt: fail
`;

const dirs: string[] = [];
const services: RunService[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function open(dir: string): Promise<RunService> {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    graphStoreDir: dir,
    eventBufferSize: 100,
    memory: { backend: "sqlite", identity: { org: "acme", project: "local" } },
  };
  const s = new RunService(config);
  await s.init();
  services.push(s);
  return s;
}

async function settle(s: RunService, threadId: string, want: string[]): Promise<string | undefined> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const st = s.registry.get(threadId)?.status;
    if (st && want.includes(st)) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  return s.registry.get(threadId)?.status;
}

describe("RunService with FLOWGRAPH_MEMORY_BACKEND=sqlite", () => {
  it("resumes a HITL run after the service restarts on the same graph store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-sqlite-resume-"));
    dirs.push(dir);
    const threadId = `sqlite-resume-${Date.now()}`;

    const a = await open(dir);
    await a.startRun({ threadId, yaml: HITL_GRAPH, input: {} });
    expect(await settle(a, threadId, ["interrupted", "error", "completed"])).toBe("interrupted");
    await a.close();
    services.splice(services.indexOf(a), 1);

    // A fresh service has no in-process session: the interrupt comes from the
    // checkpoints in <graphStoreDir>/memory.db.
    const b = await open(dir);
    expect(b.registry.get(threadId)).toBeUndefined();
    const { state: before } = await b.getState(threadId);
    expect(before?.next).toContain("gate");

    const events: string[] = [];
    const unsub = b.registry.subscribe(threadId, (ev) => void events.push(String(ev.type)));
    const ack = await b.resumeRun({ threadId, resume: { approved: true } });
    expect(ack.status).toBe("started");
    expect(await settle(b, threadId, ["completed", "error", "interrupted"])).toBe("completed");
    unsub();
    expect(events).toContain("run.end");

    const { state: after } = await b.getState(threadId);
    expect(after?.next).toEqual([]);
    expect(after?.values).toMatchObject({ approval: { approved: true } });
  });
});
