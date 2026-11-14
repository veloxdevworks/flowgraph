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
 * True when the run has stopped. The runtime emits one run-level
 * interrupt.raised carrying all pending interrupts per stop; newInterruptIds
 * distinguishes fresh notifications from gates already waiting on a sibling.
 * Non-terminal custom/node notifications without an interrupts array do not
 * end the transport stream.
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
    let unsubStatus: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      if (heartbeat) clearInterval(heartbeat);
      unsub?.();
      unsubStatus?.();
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

    try {
      unsub = registry.subscribe(threadId, write, opts.afterSeq);
    } catch (err) {
      log("warn", "events.subscribe-failed", { threadId, error: err instanceof Error ? err.message : String(err) });
      finish();
      return;
    }
    if (done) {
      unsub();
      return;
    }

    // End when the run stops being live, too: its terminal event can come before
    // the status changes (a client reconnecting with afterSeq past it sees none),
    // and some paths (a failed continue, a cancel) change the status without one.
    unsubStatus = registry.onStatus((id) => {
      if (id === threadId && !registry.hasLiveRun(threadId)) finish();
    });
    if (!registry.hasLiveRun(threadId)) {
      finish();
      return;
    }

    heartbeat = setInterval(() => {
      if (!done) res.write(": ping\n\n");
    }, opts.heartbeatMs ?? 15_000);
  });
}
