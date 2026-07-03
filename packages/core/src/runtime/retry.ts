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

function shouldRetry(err: unknown, retryOn?: Array<number | string>): boolean {
  if (!retryOn || retryOn.length === 0) return true; // retry all by default
  const message = err instanceof Error ? err.message : String(err);
  for (const matcher of retryOn) {
    if (typeof matcher === "number") {
      if (message.includes(String(matcher))) return true;
    } else if (message.includes(matcher)) {
      return true;
    }
  }
  return false;
}

export interface RetryRunnerOptions {
  retry?: RetryConfig | undefined;
  timeout?: string | undefined;
  signal?: AbortSignal | undefined;
  onRetry?: (info: { attempt: number; error: string; delayMs: number }) => void;
  onTimeout?: (info: { attempt: number; timeoutMs: number }) => void;
}

/**
 * Run `fn` with timeout and retry policy. `fn` receives the 1-based attempt number.
 */
export async function runWithPolicy<T>(
  fn: (attempt: number) => Promise<T>,
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
    try {
      if (timeoutMs === undefined) {
        return await fn(attempt);
      }
      return await withTimeout(fn(attempt), timeoutMs, () => {
        opts.onTimeout?.({ attempt, timeoutMs });
      });
    } catch (err) {
      // Never swallow interrupts — they are control flow, not failures.
      if (isInterruptLike(err)) throw err;

      lastError = err;
      const canRetry = attempt < maxAttempts && shouldRetry(err, opts.retry?.retryOn);
      if (!canRetry) break;

      const delayMs = computeDelay(attempt, backoffCfg);
      opts.onRetry?.({ attempt, error: err instanceof Error ? err.message : String(err), delayMs });
      await sleep(delayMs, opts.signal);
    }
  }

  throw lastError;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      const err = new Error(`Node timed out after ${ms}ms`) as TimeoutError;
      err.__timeout = true;
      reject(err);
    }, ms);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
