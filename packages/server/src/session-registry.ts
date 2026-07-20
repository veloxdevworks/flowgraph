import type { ServerEvent, RunStatus } from "./types.js";

export type EventListener = (event: ServerEvent) => void;

export interface ActiveSession {
  threadId: string;
  runId: string;
  status: RunStatus;
  graphName: string;
  label?: string;
  startedAt: string;
  yaml: string;
  abort: AbortController;
  pause: AbortController;
  /** Append-only buffer for SSE replay (Last-Event-ID / seq). */
  events: ServerEvent[];
  listeners: Set<EventListener>;
  /** Highest seq seen (from engine events). */
  lastSeq: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly maxEvents: number;

  constructor(maxEvents = 5000) {
    this.maxEvents = maxEvents;
  }

  get(threadId: string): ActiveSession | undefined {
    return this.sessions.get(threadId);
  }

  /** True if any session is actively running (for AgentCore HealthyBusy). */
  hasActiveWork(): boolean {
    for (const s of this.sessions.values()) {
      if (s.status === "running" || s.status === "started") return true;
    }
    return false;
  }

  activeCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "running" || s.status === "started") n++;
    }
    return n;
  }

  create(opts: {
    threadId: string;
    runId: string;
    graphName: string;
    label?: string;
    yaml: string;
  }): ActiveSession {
    const existing = this.sessions.get(opts.threadId);
    // Placeholder from an early SSE subscribe (empty runId) can be upgraded in place.
    if (
      existing &&
      existing.runId &&
      (existing.status === "running" || existing.status === "started")
    ) {
      throw new Error(`Thread "${opts.threadId}" already has an active run.`);
    }

    const listeners = existing?.listeners ?? new Set<EventListener>();
    const events = existing?.events ?? [];
    const lastSeq = existing?.lastSeq ?? 0;
    if (existing?.runId) {
      existing.abort.abort();
    }

    const session: ActiveSession = {
      threadId: opts.threadId,
      runId: opts.runId,
      status: "started",
      graphName: opts.graphName,
      ...(opts.label ? { label: opts.label } : {}),
      startedAt: new Date().toISOString(),
      yaml: opts.yaml,
      abort: new AbortController(),
      pause: new AbortController(),
      events,
      listeners,
      lastSeq,
    };
    this.sessions.set(opts.threadId, session);
    return session;
  }

  setStatus(threadId: string, status: RunStatus): void {
    const s = this.sessions.get(threadId);
    if (s) s.status = status;
  }

  pushEvent(threadId: string, event: ServerEvent): void {
    const s = this.sessions.get(threadId);
    if (!s) return;
    const stamped: ServerEvent =
      event.threadId === threadId
        ? event
        : { ...event, threadId };

    if (typeof stamped.seq === "number" && stamped.seq > s.lastSeq) {
      s.lastSeq = stamped.seq;
    }
    s.events.push(stamped);
    if (s.events.length > this.maxEvents) {
      s.events.splice(0, s.events.length - this.maxEvents);
    }
    for (const listener of s.listeners) {
      try {
        listener(stamped);
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Subscribe to live events. Optionally replay from after `afterSeq`
   * (Last-Event-ID). Returns an unsubscribe function.
   */
  subscribe(
    threadId: string,
    listener: EventListener,
    afterSeq?: number,
  ): () => void {
    let s = this.sessions.get(threadId);
    if (!s) {
      // Cold subscribe: create a placeholder so clients can attach before start
      // completes, or after process restart (events only while this process lives).
      s = {
        threadId,
        runId: "",
        status: "started",
        graphName: "",
        startedAt: new Date().toISOString(),
        yaml: "",
        abort: new AbortController(),
        pause: new AbortController(),
        events: [],
        listeners: new Set(),
        lastSeq: 0,
      };
      this.sessions.set(threadId, s);
    }

    if (afterSeq != null && afterSeq >= 0) {
      for (const ev of s.events) {
        if (ev.seq > afterSeq) {
          try {
            listener(ev);
          } catch {
            // ignore
          }
        }
      }
    }

    s.listeners.add(listener);
    return () => {
      s?.listeners.delete(listener);
    };
  }

  remove(threadId: string): void {
    this.sessions.delete(threadId);
  }

  list(): ActiveSession[] {
    return [...this.sessions.values()];
  }
}
