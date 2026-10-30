import type { ServerEvent, RunStatus, ThreadOwner } from "./types.js";

export type EventListener = (event: ServerEvent) => void;
export type GlobalEventListener = (threadId: string, event: ServerEvent) => void;

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
  dryRun?: boolean;
  /** Principal that started the session (multi-user servers). */
  owner?: ThreadOwner;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly maxEvents: number;
  private readonly globalListeners = new Set<GlobalEventListener>();
  private readonly onPersist: ((threadId: string, event: ServerEvent) => void) | undefined;
  private readonly loadJournal: ((threadId: string) => ServerEvent[]) | undefined;

  constructor(
    maxEvents = 5000,
    opts: {
      onPersist?: (threadId: string, event: ServerEvent) => void;
      loadJournal?: (threadId: string) => ServerEvent[];
    } = {},
  ) {
    this.maxEvents = maxEvents;
    this.onPersist = opts.onPersist;
    this.loadJournal = opts.loadJournal;
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
    dryRun?: boolean;
    owner?: ThreadOwner;
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
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...((opts.owner ?? existing?.owner) ? { owner: (opts.owner ?? existing?.owner) as ThreadOwner } : {}),
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
    try {
      this.onPersist?.(threadId, stamped);
    } catch {
      // persist is best-effort
    }
    for (const listener of s.listeners) {
      try {
        listener(stamped);
      } catch {
        // ignore listener errors
      }
    }
    for (const listener of this.globalListeners) {
      try {
        listener(threadId, stamped);
      } catch {
        // ignore
      }
    }
  }

  /** Subscribe to every thread's events (connect client / fan-out). */
  onGlobal(listener: GlobalEventListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
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
      // completes, or after process restart (replay from the on-disk journal).
      const loaded = this.loadJournal?.(threadId) ?? [];
      let lastSeq = 0;
      for (const ev of loaded) {
        if (typeof ev.seq === "number" && ev.seq > lastSeq) lastSeq = ev.seq;
      }
      s = {
        threadId,
        runId: "",
        status: "started",
        graphName: "",
        startedAt: new Date().toISOString(),
        yaml: "",
        abort: new AbortController(),
        pause: new AbortController(),
        events: loaded,
        listeners: new Set(),
        lastSeq,
      };
      this.sessions.set(threadId, s);
    } else if (s.events.length === 0 && this.loadJournal) {
      const loaded = this.loadJournal(threadId);
      if (loaded.length > 0) {
        s.events = loaded;
        for (const ev of loaded) {
          if (typeof ev.seq === "number" && ev.seq > s.lastSeq) s.lastSeq = ev.seq;
        }
      }
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
