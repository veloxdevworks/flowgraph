/**
 * The event bus and event types for flowgraph.
 * Events are read-only observations; they never block execution.
 */

export type EventType =
  | "run.start"
  | "run.end"
  | "run.error"
  | "run.aborted"
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
  | "intelligent.step"
  | "intelligent.tool.call"
  | "intelligent.tool.result"
  | "intelligent.token"
  | "intelligent.usage"
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
  stream(): AsyncIterable<FlowgraphEvent>;
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
    if (opts.threadId !== undefined) event.threadId = opts.threadId;

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

  async function* stream(): AsyncIterable<FlowgraphEvent> {
    // Yield already-buffered events first
    for (const ev of buffer) yield ev;

    // Then yield new events as they arrive via a push/pull queue
    const queue: FlowgraphEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const listener = (ev: FlowgraphEvent) => {
      queue.push(ev);
      resolve?.();
      resolve = null;
    };
    streamListeners.add(listener);

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((r) => { resolve = r; });
        }
        // End signal: a run.end or run.error event closes the stream
        const last = buffer[buffer.length - 1];
        if (last && (last.type === "run.end" || last.type === "run.error" || last.type === "run.aborted")) {
          done = true;
        }
      }
      // Drain remaining
      while (queue.length > 0) yield queue.shift()!;
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
