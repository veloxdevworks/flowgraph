/**
 * The event bus and event types for flowgraph.
 * Events are read-only observations; they never block execution.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const eventThread = new AsyncLocalStorage<string>();

/** @internal Keep event attribution local to an invocation, including concurrent threads. */
export function withEventThread<T>(threadId: string, run: () => T): T {
  return eventThread.run(threadId, run);
}

/** Post-reducer replacement values for public channels changed in one superstep. */
export interface StateUpdateData {
  channels: string[];
  update: Record<string, unknown>;
}

/** A selected transition; dispatch does not promise the destination will succeed. */
export interface EdgeTakenData {
  from: string;
  to: string;
  kind: "static" | "branch" | "command";
}

export type EventType =
  | "run.start"
  | "run.end"
  | "run.error"
  | "run.aborted"
  | "run.paused"
  | "run.continued"
  | "run.issue"
  | "node.start"
  | "node.end"
  | "node.error"
  | "node.skipped"
  | "node.retry"
  | "node.timeout"
  | "node.output"
  | "state.update"
  | "edge.taken"
  | "router.decision"
  | "agent.step"
  | "agent.tool.call"
  | "agent.tool.result"
  | "agent.token"
  | "agent.usage"
  | "memory.recall"
  | "agent.context"
  | "skill.preflight"
  | "skill.start"
  | "skill.end"
  | "skill.error"
  | "mcp.tool.call"
  | "mcp.tool.result"
  | "mcp.resource.read"
  | "checkpoint.write"
  | "checkpoint.load"
  | "interrupt.raised"
  | "interrupt.resumed"
  | "hook.invoked"
  | "hook.error"
  | "log"
  | `custom.${string}`;

export interface EventScope {
  nodeId?: string;
  nodeType?: string;
  parentSpanId?: string;
  attempt?: number;
  /** Set when the node ran on another machine (ADR-0020): where, and the child run's thread id. */
  placement?: { target: string; childThreadId: string };
}

let _seq = 0;

export interface FlowgraphEvent<T = unknown> {
  id: string;
  type: EventType;
  ts: string;
  runId: string;
  threadId?: string | undefined;
  graph: string;
  scope: EventScope;
  data: T;
  seq: number;
}

export type EventSink = (event: FlowgraphEvent) => void | Promise<void>;

export interface EventStreamOptions {
  /** Replay the existing buffer before live events. Default true. */
  replay?: boolean;
  /** Restrict replay and live delivery to one execution thread. */
  threadId?: string;
}

export interface EventBus {
  emit(type: EventType, data: unknown, scope?: EventScope): void;
  subscribe(sink: EventSink): () => void;
  /** For streaming: get an async iterable of events */
  stream(opts?: EventStreamOptions): AsyncIterable<FlowgraphEvent>;
}

export interface EventBusOptions {
  runId: string;
  threadId?: string;
  graph: string;
}

export function createEventBus(opts: EventBusOptions): EventBus {
  const sinks = new Set<EventSink>();
  const buffer: FlowgraphEvent[] = [];
  const streamListeners = new Set<(ev: FlowgraphEvent) => void>();

  function emit(type: EventType, data: unknown, scope: EventScope = {}): void {
    const event: FlowgraphEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      ts: new Date().toISOString(),
      runId: opts.runId,
      graph: opts.graph,
      scope,
      data,
      seq: _seq++,
    };
    const threadId = opts.threadId ?? eventThread.getStore();
    if (threadId !== undefined) event.threadId = threadId;

    buffer.push(event);

    // Notify stream listeners synchronously
    for (const listener of streamListeners) {
      listener(event);
    }

    // Fire sinks (fire-and-forget; errors are isolated)
    for (const sink of sinks) {
      try {
        const result = sink(event);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            // Sink errors must never crash the run
            console.error("[flowgraph] event sink error:", err);
          });
        }
      } catch (err) {
        console.error("[flowgraph] event sink error:", err);
      }
    }
  }

  function subscribe(sink: EventSink): () => void {
    sinks.add(sink);
    return () => sinks.delete(sink);
  }

  async function* stream(opts: EventStreamOptions = {}): AsyncIterable<FlowgraphEvent> {
    const accepts = (event: FlowgraphEvent) => opts.threadId === undefined || event.threadId === opts.threadId;
    const replay = opts.replay === false ? [] : buffer.filter(accepts);
    const queue: FlowgraphEvent[] = [];
    let resolve: (() => void) | null = null;
    const listener = (event: FlowgraphEvent) => {
      if (!accepts(event)) return;
      queue.push(event);
      resolve?.();
      resolve = null;
    };
    // Subscribe before the first yield. Execution can finish while a slow
    // consumer is reading the replay; every live event must already be queued.
    streamListeners.add(listener);
    const terminal = (event: FlowgraphEvent | undefined) => event !== undefined &&
      ["run.end", "run.error", "run.aborted", "run.paused"].includes(event.type);
    let replayEnded = false;
    for (let index = replay.length - 1; index >= 0; index--) {
      const event = replay[index]!;
      if (terminal(event)) { replayEnded = true; break; }
      if (["run.start", "interrupt.resumed", "run.continued"].includes(event.type)) break;
    }
    try {
      for (const event of replay) yield event;
      if (replayEnded) return;
      for (;;) {
        if (queue.length === 0) await new Promise<void>((resume) => { resolve = resume; });
        while (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          // Inspect the event actually delivered, not the latest global
          // buffer item: slow readers must receive all progress before end.
          if (terminal(event)) return;
        }
      }
    } finally {
      streamListeners.delete(listener);
    }
  }

  return { emit, subscribe, stream };
}

// ---------------------------------------------------------------------------
// Built-in sinks
// ---------------------------------------------------------------------------

/** Console sink — pretty-prints events */
export function consoleSink(opts: { format?: "pretty" | "json" } = {}): EventSink {
  return (event) => {
    if (opts.format === "json") {
      console.log(JSON.stringify(event));
      return;
    }
    const prefix = `[${event.type}]`.padEnd(24);
    const node = event.scope.nodeId ? ` node=${event.scope.nodeId}` : "";
    console.log(`${prefix}${node}`, event.data);
  };
}

/** JSONL sink — appends newline-delimited JSON to a writable stream */
export function jsonlSink(opts: { write: (line: string) => void }): EventSink {
  return (event) => {
    opts.write(JSON.stringify(event) + "\n");
  };
}
