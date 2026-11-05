import type { IncomingMessage, ServerResponse } from "node:http";
import { log } from "../metrics.js";
import type { ServerEvent } from "../types.js";
import type { SessionRegistry } from "../session-registry.js";

/** Open an SSE response and stream session events with Last-Event-ID replay. */
export function attachSse(
  res: ServerResponse,
  registry: SessionRegistry,
  threadId: string,
  lastEventId: string | undefined,
  req?: IncomingMessage,
): () => void {
  const started = Date.now();
  log("info", "events.subscribe", {
    threadId,
    lastEventId: lastEventId ?? null,
    remote: req?.socket.remoteAddress,
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": ok\n\n");

  let afterSeq: number | undefined;
  if (lastEventId) {
    const n = Number(lastEventId);
    if (!Number.isNaN(n)) afterSeq = n;
  }

  const writeEvent = (event: ServerEvent) => {
    const id = String(event.seq);
    res.write(`id: ${id}\n`);
    res.write(`event: engine\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const unsub = registry.subscribe(threadId, writeEvent, afterSeq);

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsub();
    log("info", "events.close", {
      threadId,
      durationMs: Date.now() - started,
      lastSeq: registry.get(threadId)?.lastSeq ?? 0,
    });
  };

  res.on("close", cleanup);
  return cleanup;
}

const TERMINAL_EVENTS = new Set(["run.end", "run.error", "run.aborted", "run.paused"]);

/**
 * True when the run has stopped. `interrupt.raised` comes in two kinds: a node
 * emits one every time it calls `interrupt()` (including when it runs again on
 * resume and gets its answer straight back), and the run emits one with
 * `data.interrupts` when it actually stops to wait. Only the second ends a run.
 */
export function isTerminalEvent(event: ServerEvent): boolean {
  const type = String(event.type);
  if (TERMINAL_EVENTS.has(type)) return true;
  if (type !== "interrupt.raised") return false;
  const data = event.data as { interrupts?: unknown } | undefined;
  return Array.isArray(data?.interrupts);
}

export interface StreamUntilTerminalOptions {
  /** Replay buffered events with a seq greater than this (like Last-Event-ID). */
  afterSeq?: number | undefined;
  /**
   * Replay the buffered events of this run first. `start` and `resume` pass the
   * run they just launched, so events emitted before the stream attached (a
   * compile error, a run that fails at once) are not lost and the stream ends.
   */
  runId?: string | undefined;
  /** Interval for `: ping` comments that keep idle proxies from closing the stream. */
  heartbeatMs?: number;
}

/**
 * Write one SSE stream of a thread's events until a terminal run event (for AgentCore).
 *
 * The stream also ends when the thread has no run in progress in this process
 * once the replay is written: on AgentCore each session is its own microVM, so
 * an `events` call that lands on a fresh one would otherwise wait forever for
 * events no run will send.
 */
export function streamEventsUntilTerminal(
  res: ServerResponse,
  registry: SessionRegistry,
  threadId: string,
  opts: StreamUntilTerminalOptions = {},
): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let done = false;
    let unsub: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      if (heartbeat) clearInterval(heartbeat);
      unsub?.();
      if (!res.writableEnded) res.end();
      resolve();
    };

    const write = (event: ServerEvent) => {
      if (done) return;
      res.write(`id: ${event.seq}\n`);
      res.write(`event: engine\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (isTerminalEvent(event)) finish();
    };

    res.on("close", finish);

    if (opts.runId) {
      for (const ev of registry.get(threadId)?.events ?? []) {
        if (ev.runId === opts.runId) write(ev);
        if (done) return;
      }
    }

    unsub = registry.subscribe(threadId, write, opts.afterSeq);
    if (done) {
      unsub();
      return;
    }

    if (!registry.hasLiveRun(threadId)) {
      finish();
      return;
    }

    heartbeat = setInterval(() => {
      if (!done) res.write(": ping\n\n");
    }, opts.heartbeatMs ?? 15_000);
  });
}
