import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerFunction } from "@veloxdevworks/flowgraph-core";
import { RunService } from "./run-service.js";
import type { ServerConfig } from "./types.js";

const COMPLETE_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hosted-complete
state:
  channels:
    text: { type: string }
    out: { type: string }
nodes:
  - id: echo
    type: function
    with:
      fn: serverEcho
      input: { text: "{{ state.text }}" }
      output: { to: out }
edges:
  - { from: START, to: echo }
  - { from: echo, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
`;

describe("RunService", () => {
  let dir: string;
  let service: RunService;

  beforeEach(async () => {
    registerFunction("serverEcho", (input) => {
      const obj = input as { text?: string };
      return obj.text ?? "ok";
    });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-server-"));
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      graphStoreDir: dir,
      eventBufferSize: 100,
    };
    service = new RunService(config);
    await service.init();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects client secrets", async () => {
    await expect(
      service.startRun({
        threadId: "t1",
        yaml: COMPLETE_GRAPH,
        env: { OPENAI_API_KEY: "x" },
      }),
    ).rejects.toThrow(/reject/);
  });

  it("starts a run and emits events", async () => {
    const threadId = `t-${Date.now()}`;
    const events: string[] = [];
    const unsub = service.registry.subscribe(threadId, (ev) => {
      events.push(String(ev.type));
    });

    const result = await service.startRun({
      threadId,
      yaml: COMPLETE_GRAPH,
      input: { text: "hi" },
    });
    expect(result.status).toBe("started");
    expect(result.runId).toBeTruthy();

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        const s = service.registry.get(threadId);
        if (s && (s.status === "completed" || s.status === "error" || s.status === "interrupted")) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`timeout waiting for run; status=${s?.status}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

    unsub();
    expect(events).toContain("run.start");
    expect(events).toContain("run.end");
    expect(service.registry.get(threadId)?.status).toBe("completed");
  });

  it("persists uploaded yaml", async () => {
    const threadId = `persist-${Date.now()}`;
    await service.startRun({ threadId, yaml: COMPLETE_GRAPH, input: { text: "x" } });
    // Wait briefly for async run
    await new Promise((r) => setTimeout(r, 200));
    const file = path.join(dir, `${threadId}.graph.yaml`);
    const raw = await fs.readFile(file, "utf-8");
    expect(raw).toContain("hosted-complete");
  });

  it("resumeRun returns started immediately and completes via events", async () => {
    const HITL_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hosted-hitl
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
    const threadId = `resume-${Date.now()}`;
    const events: string[] = [];
    const unsub = service.registry.subscribe(threadId, (ev) => {
      events.push(String(ev.type));
    });

    await service.startRun({ threadId, yaml: HITL_GRAPH, input: {} });

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        const s = service.registry.get(threadId);
        if (s && (s.status === "interrupted" || s.status === "error")) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`timeout waiting for interrupt; status=${s?.status}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
    expect(service.registry.get(threadId)?.status).toBe("interrupted");

    const ack = await service.resumeRun({
      threadId,
      resume: { approved: true },
    });
    expect(ack.status).toBe("started");
    expect(ack.runId).toBeTruthy();

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        const s = service.registry.get(threadId);
        if (s && (s.status === "completed" || s.status === "error")) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`timeout waiting for resume completion; status=${s?.status}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

    unsub();
    expect(events).toContain("interrupt.raised");
    expect(events).toContain("run.end");
    expect(service.registry.get(threadId)?.status).toBe("completed");
  });
});
