import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunService } from "./run-service.js";
import type { ResumeRunRequest, RunStatus } from "./types.js";
import { ConnectClient, type WebSocketLike } from "./connect/client.js";
import { CONNECT_PROTOCOL_VERSION } from "./connect/protocol.js";

const HITL_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: resume-required
state:
  channels:
    approval: { type: object }
nodes:
  - id: gate
    type: hitl
    with: { mode: approve, message: "Approve?", output: { to: approval } }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
  hitl: { onInterrupt: fail }
`;

/** Resolves when the registry next records `want` for the thread; no polling. */
function statusReached(service: RunService, threadId: string, want: RunStatus): Promise<void> {
  const registry = service.registry;
  const original = registry.setStatus.bind(registry);
  return new Promise((resolve) => {
    registry.setStatus = (id, status) => {
      original(id, status);
      if (id === threadId && status === want) {
        registry.setStatus = original;
        resolve();
      }
    };
  });
}

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

describe("RunService.resumeRun without a resume value", () => {
  let dir: string;
  let service: RunService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-resume-required-"));
    service = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100 });
    await service.init();
  });

  afterEach(async () => {
    await service?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function interruptedThread(threadId: string): Promise<string[]> {
    const events: string[] = [];
    service.registry.subscribe(threadId, (ev) => {
      events.push(String(ev.type));
    });
    const interrupted = statusReached(service, threadId, "interrupted");
    await service.startRun({ threadId, yaml: HITL_GRAPH, input: {} });
    await interrupted;
    return events;
  }

  it("refuses with 400 RESUME_REQUIRED and leaves the gate pending", async () => {
    const threadId = "resume-required-direct";
    const events = await interruptedThread(threadId);

    for (const req of [{ threadId }, { threadId, resume: undefined }] as ResumeRunRequest[]) {
      await expect(service.resumeRun(req)).rejects.toMatchObject({
        name: "ServerRequestError",
        status: 400,
        code: "RESUME_REQUIRED",
      });
    }
    expect(service.registry.get(threadId)?.status).toBe("interrupted");
    expect(events).not.toContain("run.error");
    const state = (await service.getState(threadId)).state as { next?: string[] };
    expect(state.next).toEqual(["gate"]);

    const completed = statusReached(service, threadId, "completed");
    expect((await service.resumeRun({ threadId, resume: false })).status).toBe("started");
    await completed;
    expect(events).not.toContain("run.error");
  });

  it("answers a connect run.resume with no value with an error reply, not started", async () => {
    const threadId = "resume-required-connect";
    const events = await interruptedThread(threadId);

    let socket: FakeSocket | undefined;
    const client = new ConnectClient({
      url: "wss://platform.test/connect",
      service,
      webSocket: class {
        constructor() {
          socket = new FakeSocket();
          return socket;
        }
      } as unknown as new (url: string) => WebSocketLike,
    });
    client.start();
    socket!.emit("open");
    socket!.emit("message", JSON.stringify({ type: "hello.ack", protocolVersion: CONNECT_PROTOCOL_VERSION, sessionId: "s1" }));

    const reply = new Promise<Record<string, unknown>>((resolve) => {
      const send = socket!.send.bind(socket);
      socket!.send = (data: string) => {
        send(data);
        const msg = JSON.parse(data) as Record<string, unknown>;
        if (msg.type === "command.result" && msg.id === "r1") resolve(msg);
      };
    });
    socket!.emit("message", JSON.stringify({ type: "command", id: "r1", method: "run.resume", params: { threadId } }));
    const result = await reply;
    client.stop();

    expect(result).toMatchObject({ ok: false, code: "RESUME_REQUIRED" });
    expect(result).not.toHaveProperty("result");
    expect(service.registry.get(threadId)?.status).toBe("interrupted");
    expect(events).not.toContain("run.error");
  });
});
