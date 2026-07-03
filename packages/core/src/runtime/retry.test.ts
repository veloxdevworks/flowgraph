import { describe, it, expect } from "vitest";
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
