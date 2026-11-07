import { describe, it, expect, vi } from "vitest";
import { sleep } from "./duration.js";
import { runWithPolicy, isTimeoutError } from "./retry.js";

describe("runWithPolicy", () => {
  it("retries up to maxAttempts then succeeds", async () => {
    let attempts = 0;
    const result = await runWithPolicy(
      async (attempt) => {
        attempts = attempt;
        if (attempt < 3) throw new Error("transient");
        return "ok";
      },
      { retry: { maxAttempts: 3, backoff: "fixed", baseMs: 1, jitter: false } },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("throws after exhausting attempts", async () => {
    let calls = 0;
    await expect(
      runWithPolicy(
        async () => { calls++; throw new Error("always"); },
        { retry: { maxAttempts: 2, backoff: "fixed", baseMs: 1, jitter: false } },
      ),
    ).rejects.toThrow("always");
    expect(calls).toBe(2);
  });

  it("only retries matching errors via retryOn", async () => {
    let calls = 0;
    await expect(
      runWithPolicy(
        async () => { calls++; throw new Error("status 500"); },
        { retry: { maxAttempts: 4, baseMs: 1, jitter: false, retryOn: [429, 503] } },
      ),
    ).rejects.toThrow("500");
    expect(calls).toBe(1); // 500 is not in retryOn → no retry
  });

  it("times out a slow call", async () => {
    const err = await runWithPolicy(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
      { timeout: "20ms" },
    ).catch((e) => e);
    expect(isTimeoutError(err)).toBe(true);
  });

  it("aborts the attempt's signal on timeout, with the timeout error as the reason", async () => {
    let seen: AbortSignal | undefined;
    const err = await runWithPolicy(
      (_attempt, signal) => {
        seen = signal;
        return new Promise(() => {});
      },
      { timeout: "10ms" },
    ).catch((e) => e);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(err);
    expect(isTimeoutError(seen?.reason)).toBe(true);
  });

  it("gives each attempt a signal of its own, which a run's cancel also aborts", async () => {
    const run = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const done = runWithPolicy(
      (attempt, signal) => {
        signals.push(signal);
        if (attempt === 1) return Promise.reject(new Error("transient"));
        run.abort(new Error("cancelled"));
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
        });
      },
      { timeout: "1h", signal: run.signal, retry: { maxAttempts: 2, baseMs: 1, jitter: false } },
    );
    await expect(done).rejects.toThrow("cancelled");
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]?.reason).toBe(run.signal.reason);
  });

  it("passes the run's own signal when there is no timeout", async () => {
    const run = new AbortController();
    const seen = await runWithPolicy(async (_attempt, signal) => signal, { signal: run.signal });
    expect(seen).toBe(run.signal);
  });

  it("does not retry once the run is cancelled", async () => {
    const run = new AbortController();
    let calls = 0;
    const retries: unknown[] = [];
    await expect(
      runWithPolicy(
        async () => {
          calls++;
          run.abort(new Error("cancelled"));
          throw run.signal.reason;
        },
        { signal: run.signal, retry: { maxAttempts: 3, baseMs: 1 }, onRetry: (info) => retries.push(info) },
      ),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it("waits for a timed-out attempt to stop before the next one", async () => {
    const events: string[] = [];
    await runWithPolicy(
      (attempt, signal) => {
        events.push(`start ${attempt}`);
        if (attempt === 2) return Promise.resolve("ok");
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            setTimeout(() => {
              events.push(`stopped ${attempt}`);
              reject(signal.reason);
            }, 50);
          });
        });
      },
      { timeout: "10ms", stopGraceMs: 5_000, retry: { maxAttempts: 2, baseMs: 1, jitter: false } },
    );
    expect(events).toEqual(["start 1", "stopped 1", "start 2"]);
  });

  it("gives up waiting for an attempt that does not stop, after the grace", async () => {
    let calls = 0;
    const started = Date.now();
    await runWithPolicy(
      (attempt) => {
        calls++;
        return attempt === 2 ? Promise.resolve("ok") : new Promise(() => {});
      },
      { timeout: "10ms", stopGraceMs: 100, retry: { maxAttempts: 2, baseMs: 1, jitter: false } },
    );
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("does not wait for an attempt that failed by itself", async () => {
    const started = Date.now();
    await runWithPolicy(
      async (attempt) => {
        if (attempt === 1) throw new Error("transient");
        return "ok";
      },
      { timeout: "1h", stopGraceMs: 5_000, retry: { maxAttempts: 2, baseMs: 1, jitter: false } },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("sleep leaves no abort listener behind", async () => {
    const run = new AbortController();
    const remove = vi.spyOn(run.signal, "removeEventListener");
    await sleep(1, run.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not retry interrupt-like errors", async () => {
    let calls = 0;
    const interruptErr = Object.assign(new Error("interrupt"), { name: "GraphInterrupt" });
    await expect(
      runWithPolicy(
        async () => { calls++; throw interruptErr; },
        { retry: { maxAttempts: 5, baseMs: 1 } },
      ),
    ).rejects.toBe(interruptErr);
    expect(calls).toBe(1);
  });
});
