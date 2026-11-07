import { afterEach, describe, expect, it, vi } from "vitest";
import { abortOnSignals } from "./run-signal.js";

describe("abortOnSignals", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["SIGINT", "SIGTERM"] as const)("%s aborts the run once and exits on the second", (name) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const onFirst = vi.fn();
    const cancel = abortOnSignals(onFirst);
    try {
      expect(cancel.signal.aborted).toBe(false);

      process.emit(name, name);
      expect(cancel.signal.aborted).toBe(true);
      expect((cancel.signal.reason as Error).message).toContain(name);
      expect(onFirst).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();

      process.emit(name, name);
      expect(exit).toHaveBeenCalledWith(130);
      expect(onFirst).toHaveBeenCalledTimes(1);
    } finally {
      cancel.dispose();
    }
  });

  it("stops listening once disposed, so later waits handle Ctrl-C themselves", () => {
    const before = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const cancel = abortOnSignals(() => {});
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    cancel.dispose();
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
});
