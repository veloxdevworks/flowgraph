import { describe, expect, it, vi } from "vitest";
import { ConnectClient, type WebSocketLike } from "./client.js";
import { CONNECT_PROTOCOL_VERSION } from "./protocol.js";
import type { RunService } from "../run-service.js";
import { SessionRegistry } from "../session-registry.js";

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
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

describe("ConnectClient", () => {
  it("sends hello on open and command.result after hello.ack", async () => {
    let socket: FakeSocket | undefined;
    const listRuns = vi.fn(async () => [{ threadId: "t1", status: "completed" }]);
    const service = {
      registry: new SessionRegistry(),
      listRuns,
    } as unknown as RunService;

    const client = new ConnectClient({
      url: "ws://platform.test/connect",
      token: "tok",
      service,
      webSocket: class {
        constructor() {
          socket = new FakeSocket();
          return socket;
        }
      } as unknown as new (url: string) => WebSocketLike,
      helloTimeoutMs: 5_000,
    });
    client.start();
    expect(socket).toBeDefined();
    socket!.emit("open");

    const hello = JSON.parse(socket!.sent[0]!) as {
      type: string;
      protocolVersion: number;
      token?: string;
    };
    expect(hello).toMatchObject({
      type: "hello",
      protocolVersion: CONNECT_PROTOCOL_VERSION,
      token: "tok",
    });

    socket!.emit(
      "message",
      JSON.stringify({
        type: "hello.ack",
        protocolVersion: CONNECT_PROTOCOL_VERSION,
        sessionId: "s1",
      }),
    );
    expect(client.isReady).toBe(true);

    socket!.emit(
      "message",
      JSON.stringify({ type: "command", id: "c1", method: "run.list", params: {} }),
    );
    await vi.waitFor(() => {
      expect(socket!.sent.some((s) => s.includes("command.result"))).toBe(true);
    });
    const result = JSON.parse(
      socket!.sent.find((s) => s.includes("command.result"))!,
    ) as { ok: boolean; id: string; result?: { runs: unknown[] } };
    expect(result).toMatchObject({ id: "c1", ok: true });
    expect(result.result?.runs).toHaveLength(1);
    client.stop();
  });

  it("rejects unknown methods", async () => {
    let socket: FakeSocket | undefined;
    const service = {
      registry: new SessionRegistry(),
    } as unknown as RunService;
    const client = new ConnectClient({
      url: "ws://platform.test/connect",
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
    socket!.emit(
      "message",
      JSON.stringify({
        type: "hello.ack",
        protocolVersion: CONNECT_PROTOCOL_VERSION,
        sessionId: "s1",
      }),
    );
    socket!.emit(
      "message",
      JSON.stringify({ type: "command", id: "c2", method: "nope", params: {} }),
    );
    await vi.waitFor(() => {
      expect(socket!.sent.some((s) => s.includes("Unknown connect method"))).toBe(true);
    });
    client.stop();
  });
});
