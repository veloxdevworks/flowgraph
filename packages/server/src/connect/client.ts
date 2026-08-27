/**
 * Optional outbound WebSocket connect client (ADR-0014).
 *
 * Dials Velox Platform when `FLOWGRAPH_CONNECT_URL` is set, maps inbound
 * `command` messages onto `RunService`, and batches engine events upstream
 * as `event.batch`. Transport-only — no org/authz/library logic.
 */

import type { ServerEvent } from "../types.js";
import type { RunService } from "../run-service.js";
import { errorFields, log } from "../metrics.js";
import {
  CONNECT_PROTOCOL_VERSION,
  isCommand,
  isHelloAck,
  type ConnectCommand,
  type ConnectOutbound,
} from "./protocol.js";

export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
};

export type WebSocketCtor = new (url: string) => WebSocketLike;

export type ConnectClientOptions = {
  url: string;
  token?: string;
  service: RunService;
  /** Injected for tests. Defaults to global `WebSocket` when available. */
  webSocket?: WebSocketCtor;
  helloTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

const OPEN = 1;

export class ConnectClient {
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private ready = false;
  private reconnectAttempt = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubGlobal: (() => void) | null = null;
  private pending = new Map<string, ServerEvent[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly helloTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  constructor(private readonly opts: ConnectClientOptions) {
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 15_000;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
  }

  start(): void {
    this.stopped = false;
    this.unsubGlobal = this.opts.service.registry.onGlobal((threadId, event) => {
      this.enqueue(threadId, event);
    });
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.unsubGlobal?.();
    this.unsubGlobal = null;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.ws?.close();
    this.ws = null;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Test helper: inject an inbound JSON message. */
  handleMessageForTests(raw: string): void {
    this.onMessage(raw);
  }

  private webSocketCtor(): WebSocketCtor {
    if (this.opts.webSocket) return this.opts.webSocket;
    const g = globalThis as { WebSocket?: WebSocketCtor };
    if (typeof g.WebSocket === "function") return g.WebSocket;
    throw new Error("WebSocket is not available in this runtime");
  }

  private dial(): void {
    if (this.stopped) return;
    try {
      const Ctor = this.webSocketCtor();
      const ws = new Ctor(this.opts.url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        this.send({
          type: "hello",
          protocolVersion: CONNECT_PROTOCOL_VERSION,
          ...(this.opts.token ? { token: this.opts.token } : {}),
          capabilities: ["runs"],
        });
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = setTimeout(() => {
          if (!this.ready) {
            log("warn", "connect.hello.timeout", { url: this.opts.url });
            ws.close();
          }
        }, this.helloTimeoutMs);
      });
      ws.addEventListener("message", (ev) => {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data ?? "");
        this.onMessage(data);
      });
      ws.addEventListener("close", () => {
        this.ready = false;
        this.scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        this.ready = false;
      });
    } catch (err) {
      log("error", "connect.dial.failed", {
        url: this.opts.url,
        ...errorFields(err),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    log("info", "connect.reconnect", { delayMs: delay, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial();
    }, delay);
  }

  private send(msg: ConnectOutbound): void {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // ignore send errors; close/reconnect will follow
    }
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (isHelloAck(parsed)) {
      if (parsed.protocolVersion !== CONNECT_PROTOCOL_VERSION) {
        log("warn", "connect.hello.version-mismatch", {
          got: parsed.protocolVersion,
          want: CONNECT_PROTOCOL_VERSION,
        });
        this.ws?.close();
        return;
      }
      this.ready = true;
      if (this.helloTimer) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
      }
      log("info", "connect.ready", { sessionId: parsed.sessionId });
      this.flushAll();
      return;
    }
    if (isCommand(parsed)) {
      void this.dispatch(parsed);
    }
  }

  private async dispatch(cmd: ConnectCommand): Promise<void> {
    const p = cmd.params ?? {};
    const threadId = String(p.threadId ?? "");
    try {
      let result: unknown;
      switch (cmd.method) {
        case "run.start":
          result = await this.opts.service.startRun({
            threadId,
            yaml: String(p.yaml ?? ""),
            ...(p.input && typeof p.input === "object"
              ? { input: p.input as Record<string, unknown> }
              : {}),
            ...(typeof p.label === "string" ? { label: p.label } : {}),
            ...(p.dryRun ? { dryRun: true } : {}),
          });
          break;
        case "run.resume":
          result = await this.opts.service.resumeRun({
            threadId,
            resume: p.resume,
            ...(typeof p.yaml === "string" ? { yaml: p.yaml } : {}),
          });
          break;
        case "run.cancel":
          result = await this.opts.service.cancelRun(threadId);
          break;
        case "run.pause":
          result = await this.opts.service.pauseRun(threadId);
          break;
        case "run.continue":
          result = await this.opts.service.continueRun(
            threadId,
            typeof p.yaml === "string" ? p.yaml : undefined,
          );
          break;
        case "run.state":
          result = await this.opts.service.getState(
            threadId,
            typeof p.yaml === "string" ? p.yaml : undefined,
          );
          break;
        case "run.history":
          result = await this.opts.service.getHistory(
            threadId,
            typeof p.yaml === "string" ? p.yaml : undefined,
          );
          break;
        case "run.list":
          result = { runs: await this.opts.service.listRuns() };
          break;
        default:
          throw new Error(`Unknown connect method "${cmd.method}"`);
      }
      this.send({ type: "command.result", id: cmd.id, ok: true, result });
    } catch (err) {
      this.send({
        type: "command.result",
        id: cmd.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private enqueue(threadId: string, event: ServerEvent): void {
    const list = this.pending.get(threadId) ?? [];
    list.push(event);
    this.pending.set(threadId, list);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushAll();
    }, 50);
  }

  private flushAll(): void {
    if (!this.ready) return;
    for (const [threadId, events] of this.pending) {
      if (events.length === 0) continue;
      const batch = events.splice(0, 50);
      this.send({ type: "event.batch", threadId, events: batch });
      if (events.length === 0) this.pending.delete(threadId);
    }
  }
}

export function startConnectClient(opts: ConnectClientOptions): ConnectClient {
  const client = new ConnectClient(opts);
  client.start();
  return client;
}
