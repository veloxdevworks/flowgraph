import type { ServerResponse } from "node:http";
import type { ServerEvent } from "../types.js";
import type { SessionRegistry } from "../session-registry.js";

/** Open an SSE response and stream session events with Last-Event-ID replay. */
export function attachSse(
  res: ServerResponse,
  registry: SessionRegistry,
  threadId: string,
  lastEventId: string | undefined,
): () => void {
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
  };

  res.on("close", cleanup);
  return cleanup;
}

/** Write a single JSON SSE stream of events until a terminal run event (for AgentCore). */
export function streamEventsUntilTerminal(
  res: ServerResponse,
  registry: SessionRegistry,
  threadId: string,
  afterSeq?: number,
): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const terminal = new Set([
      "run.end",
      "run.error",
      "run.aborted",
      "run.paused",
      "interrupt.raised",
    ]);

    const unsub = registry.subscribe(
      threadId,
      (event) => {
        res.write(`id: ${event.seq}\n`);
        res.write(`event: engine\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (terminal.has(String(event.type))) {
          unsub();
          res.end();
          resolve();
        }
      },
      afterSeq,
    );

    res.on("close", () => {
      unsub();
      resolve();
    });
  });
}
