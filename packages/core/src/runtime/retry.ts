/**
 * Retry + timeout middleware for node execution.
 *
 * Wraps a node's run function with:
 *   - timeout (rejects + emits node.timeout)
 *   - retry with configurable backoff (emits node.retry)
 *
 * Note: these retries happen within a single superstep. Durability across
 * process restarts is handled by the checkpointer + resume, not here.
 */

import { parseDuration, sleep } from "./duration.js";

export interface RetryConfig {
  maxAttempts?: number;
  backoff?: "fixed" | "linear" | "exponential";
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  retryOn?: Array<number | string>;
  jitter?: boolean;
}

export interface TimeoutError extends Error {
  __timeout: true;
}

export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof Error && (err as TimeoutError).__timeout === true;
}

/** Interrupts must bubble straight through retry/timeout without being caught. */
function isInterruptLike(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  return (
    "__interrupt" in err ||
    name === "GraphInterrupt" ||
    name === "NodeInterrupt" ||
    "lg_interrupt" in err
  );
}

function computeDelay(attempt: number, cfg: Required<Pick<RetryConfig, "backoff" | "baseMs" | "maxMs" | "factor" | "jitter">>): number {
  let delay: number;
  switch (cfg.backoff) {
    case "fixed":  delay = cfg.baseMs; break;
    case "linear": delay = cfg.baseMs * attempt; break;
    case "exponential":
    default:       delay = cfg.baseMs * Math.pow(cfg.factor, attempt - 1); break;
  }
  delay = Math.min(delay, cfg.maxMs);
  if (cfg.jitter) delay = delay * (0.5 + Math.random() * 0.5);
  return Math.round(delay);
}

/**
 * Errors that mark themselves `retryable: false` (directly or through
 * `cause`) fail the same way on every attempt, e.g. a context budget
 * overflow, so they are never retried.
 */
export function isNonRetryable(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    if ((cur as { retryable?: unknown }).retryable === false) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function shouldRetry(err: unknown, retryOn?: Array<number | string>): boolean {
  if (isNonRetryable(err)) return false;
  if (!retryOn || retryOn.length === 0) return true; // retry all by default
  const message = err instanceof Error ? err.message : String(err);
  for (const matcher of retryOn) {
    const fields = err && typeof err === "object" ? err as { code?: unknown; status?: unknown; statusCode?: unknown } : {};
    if ([fields.code, fields.status, fields.statusCode].some(value => value != null && String(value) === String(matcher))) return true;
    const escaped = String(matcher).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped && new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "u").test(message)) return true;
  }
  return false;
}

export interface RetryRunnerOptions {
  retry?: RetryConfig | undefined;
  timeout?: string | undefined;
  signal?: AbortSignal | undefined;
  /**
   * How long a timed-out attempt gets to stop before the next attempt or the failure, so its
   * side effects don't overlap what comes next. Default 0: an attempt that ignores its signal
   * would otherwise hold up every timeout.
   */
  stopGraceMs?: number | undefined;
  onRetry?: (info: { attempt: number; error: string; delayMs: number }) => void;
  onTimeout?: (info: { attempt: number; timeoutMs: number }) => void;
}

/**
 * Run `fn` with timeout and retry policy. `fn` receives the 1-based attempt number and the
 * signal for that attempt, which aborts when the attempt times out or `opts.signal` aborts.
 * The reason tells them apart: `isTimeoutError(signal.reason)` for a timeout.
 */
export async function runWithPolicy<T>(
  fn: (attempt: number, signal: AbortSignal | undefined) => Promise<T>,
  opts: RetryRunnerOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.retry?.maxAttempts ?? 1);
  const backoffCfg = {
    backoff: opts.retry?.backoff ?? "exponential",
    baseMs: opts.retry?.baseMs ?? 500,
    maxMs: opts.retry?.maxMs ?? 30_000,
    factor: opts.retry?.factor ?? 2,
    jitter: opts.retry?.jitter ?? true,
  } as const;
  const timeoutMs = opts.timeout ? parseDuration(opts.timeout) : undefined;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timedOut = timeoutMs === undefined ? undefined : new AbortController();
    let signal = opts.signal;
    if (timedOut) signal = opts.signal ? AbortSignal.any([opts.signal, timedOut.signal]) : timedOut.signal;
    let running: Promise<T> | undefined;
    try {
      running = fn(attempt, signal);
      if (!timedOut) return await running;
      return await withTimeout(running, timeoutMs!, timedOut, () => {
        opts.onTimeout?.({ attempt, timeoutMs: timeoutMs! });
      });
    } catch (err) {
      // Never swallow interrupts — they are control flow, not failures.
      if (isInterruptLike(err)) throw err;

      lastError = err;
      // The run was cancelled: another attempt would only fail the same way.
      if (opts.signal?.aborted) break;
      if (isTimeoutError(err) && running && opts.stopGraceMs) {
        await settledWithin(running, opts.stopGraceMs, opts.signal);
        if (opts.signal?.aborted) break;
      }
      const canRetry = attempt < maxAttempts && shouldRetry(err, opts.retry?.retryOn);
      if (!canRetry) break;

      const delayMs = computeDelay(attempt, backoffCfg);
      opts.onRetry?.({ attempt, error: err instanceof Error ? err.message : String(err), delayMs });
      await sleep(delayMs, opts.signal);
    }
  }

  throw lastError;
}

/** Wait for `promise` to settle either way, for at most `ms`, or until `signal` aborts. */
function settledWithin(promise: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
    promise.then(done, done);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timedOut: AbortController,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      const err = new Error(`Node timed out after ${ms}ms`) as TimeoutError;
      err.__timeout = true;
      // Stop the attempt too: rejecting only stops waiting for it, and it would carry on.
      timedOut.abort(err);
      reject(err);
    }, ms);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
