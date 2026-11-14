import { usageLedgerOf } from "./usage/ledger.js";
import { AsyncLocalStorage } from "node:async_hooks";

const eventThread = new AsyncLocalStorage<string>();

/** @internal Keep event attribution local to an invocation, including concurrent threads. */
export function withEventThread<T>(threadId: string, run: () => T): T {
  return eventThread.run(threadId, run);
}

/**
 * The event bus and event types for flowgraph.
 * Events are read-only observations; they never block execution.
 */

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

export interface EventBus {
  emit(type: EventType, data: unknown, scope?: EventScope): void;
  subscribe(sink: EventSink): () => void;
  /** For streaming: get an async iterable of events */
  stream(opts?: { threadId?: string; includeBuffered?: boolean; signal?: AbortSignal }): AsyncIterable<FlowgraphEvent>;
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
    const accounting = usageLedgerOf();
    if (accounting && ["run.end", "run.error", "run.aborted", "run.paused"].includes(type)) {
      data = { ...(data as Record<string, unknown>), usage: accounting.snapshot() };
    }
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

  async function* stream(options: { threadId?: string; includeBuffered?: boolean; signal?: AbortSignal } = {}): AsyncIterable<FlowgraphEvent> {
    const matches = (ev: FlowgraphEvent) => options.threadId === undefined || ev.threadId === options.threadId;
    const history = options.includeBuffered === false ? [] : buffer.filter(matches);
    const queue: FlowgraphEvent[] = [];
    let resolve: (() => void) | undefined;
    let done = options.signal?.aborted ?? false;
    const wake = () => { resolve?.(); resolve = undefined; };
    const listener = (ev: FlowgraphEvent) => { if (matches(ev)) { queue.push(ev); wake(); } };
    const abort = () => { done = true; wake(); };
    streamListeners.add(listener);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      for (const ev of history) yield ev;
      while (!done || queue.length > 0) {
        const ev = queue.shift();
        if (!ev) { await new Promise<void>(r => { resolve = r; }); continue; }
        yield ev;
        if (["run.end", "run.error", "run.aborted", "run.paused"].includes(ev.type)) done = true;
      }
    } finally {
      streamListeners.delete(listener);
      options.signal?.removeEventListener("abort", abort);
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
