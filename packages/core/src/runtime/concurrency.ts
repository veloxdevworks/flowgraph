import { runScopeOf } from "../providers/replay-cache.js";

/** Limits actual work, leaving LangGraph dispatch/join tasks free to make progress. */
class ExecutionLimiter {
  private active = 0;
  private queue: Array<{ admit(): void; cancelled: boolean }> = [];
  private head = 0;
  constructor(private readonly maximum: number) {}

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          cancelled: false,
          admit: () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          },
        };
        const abort = () => {
          waiter.cancelled = true;
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        this.queue.push(waiter);
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      for (;;) {
        const next = this.queue[this.head++];
        if (!next) {
          this.queue = [];
          this.head = 0;
          break;
        }
        if (next.cancelled) continue;
        this.active++;
        next.admit();
        break;
      }
    };
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  }
}

export type ExecutionLimit = <T>(
  work: () => Promise<T>,
  config?: unknown,
  signal?: AbortSignal,
) => Promise<T>;

/** Replay stores identify invocations and are shared by all tasks of that invocation. */
export function createExecutionLimit(maximum?: number): ExecutionLimit {
  if (maximum !== undefined && (!Number.isInteger(maximum) || maximum < 1))
    throw new Error("concurrency must be a positive integer");
  const limits = new WeakMap<object, ExecutionLimiter>();
  const embedded = {};
  return async (work, config, signal) => {
    if (maximum === undefined) {
      signal?.throwIfAborted();
      return work();
    }
    const key = runScopeOf(config)?.replay ?? embedded;
    let limiter = limits.get(key);
    if (!limiter) {
      limiter = new ExecutionLimiter(maximum);
      limits.set(key, limiter);
    }
    return limiter.run(work, signal);
  };
}
