import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunService } from "./run-service.js";
import type { RunStatus } from "./types.js";
import { ConnectClient, type WebSocketLike } from "./connect/client.js";
import { CONNECT_PROTOCOL_VERSION } from "./connect/protocol.js";
import { handleRest } from "./http/rest.js";
import { handleAgentCore } from "./http/agentcore.js";

const HITL_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: resume-map-required
state:
  channels:
    gateA: { type: object }
    gateB: { type: object }
nodes:
  - id: gate-a
    type: hitl
    with: { mode: approve, message: "A?", output: { to: gateA } }
  - id: gate-b
    type: hitl
    with: { mode: approve, message: "B?", output: { to: gateB } }
edges:
  - { from: START, to: [gate-a, gate-b] }
  - { from: gate-a, to: END }
  - { from: gate-b, to: END }
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

function postReq(body: string): IncomingMessage {
  return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method: "POST",
  }) as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(payload: string) {
      this.body = JSON.parse(payload);
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: unknown };
}

describe("RunService.resumeRun with several pending interrupts", () => {
  let dir: string;
  let service: RunService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-resume-map-required-"));
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

  async function expectUntouched(threadId: string, events: string[]): Promise<void> {
    expect(service.registry.get(threadId)?.status).toBe("interrupted");
    expect(events).not.toContain("run.error");
    const state = (await service.getState(threadId)).state as { next?: string[]; interrupts?: unknown[] };
    expect(state.next?.slice().sort()).toEqual(["gate-a", "gate-b"]);
    expect(state.interrupts).toHaveLength(2);
  }

  it("refuses with 400 RESUME_MAP_REQUIRED and leaves both gates pending", async () => {
    const threadId = "resume-map-required-direct";
    const events = await interruptedThread(threadId);

    await expect(service.resumeRun({ threadId, resume: { approved: true } })).rejects.toMatchObject({
      name: "ServerRequestError",
      status: 400,
      code: "RESUME_MAP_REQUIRED",
    });
    await expectUntouched(threadId, events);

    const completed = statusReached(service, threadId, "completed");
    expect((await service.resumeRun({ threadId, resume: false })).status).toBe("started");
    await completed;
    expect(events).not.toContain("run.error");
  });

  it("answers a connect run.resume with an unkeyed value with an error reply, not started", async () => {
    const threadId = "resume-map-required-connect";
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
    socket!.emit(
      "message",
      JSON.stringify({
        type: "command",
        id: "r1",
        method: "run.resume",
        params: { threadId, resume: { approved: true } },
      }),
    );
    const result = await reply;
    client.stop();

    expect(result).toMatchObject({ ok: false, code: "RESUME_MAP_REQUIRED" });
    expect(result).not.toHaveProperty("result");
    await expectUntouched(threadId, events);
  });

  it("answers REST and agentcore resume with 400 RESUME_MAP_REQUIRED", async () => {
    const restId = "resume-map-required-rest";
    const restEvents = await interruptedThread(restId);
    const restRes = mockRes();
    await handleRest(
      postReq(JSON.stringify({ resume: { approved: true } })),
      restRes,
      service,
      new URL(`http://localhost/runs/${restId}/resume`),
    );
    expect(restRes.statusCode).toBe(400);
    expect(restRes.body).toMatchObject({ code: "RESUME_MAP_REQUIRED" });
    await expectUntouched(restId, restEvents);

    const acId = "resume-map-required-agentcore";
    const acEvents = await interruptedThread(acId);
    const acRes = mockRes();
    await handleAgentCore(
      postReq(JSON.stringify({ action: "resume", threadId: acId, resume: { approved: true }, stream: false })),
      acRes,
      service,
      "/invocations",
    );
    expect(acRes.statusCode).toBe(400);
    expect(acRes.body).toMatchObject({ code: "RESUME_MAP_REQUIRED" });
    await expectUntouched(acId, acEvents);
  });
});
