import { describe, expect, it } from "vitest";
import { createExecutionLimit } from "./concurrency.js";
import { ReplayStore, RUN_SCOPE_KEY } from "../providers/replay-cache.js";
import { reduceMapCollect } from "./state-annotation.js";

describe("execution admission", () => {
  it.each([0, -1, 0.5, Infinity, NaN])(
    "rejects an invalid limit %s before work can stall",
    (limit) => {
      expect(() => createExecutionLimit(limit)).toThrow(/positive integer/);
    },
  );
  it("keeps separate invocations independent while bounding each invocation", async () => {
    const limit = createExecutionLimit(1);
    const configs = [0, 1].map(() => ({
      configurable: { [RUN_SCOPE_KEY]: { replay: new ReplayStore(), path: [] } },
    }));
    const active = [0, 0];
    let total = 0;
    let peak = 0;
    await Promise.all(
      [0, 0, 1, 1].map((id) =>
        limit(async () => {
          active[id] = (active[id] ?? 0) + 1;
          expect(active[id]).toBe(1);
          peak = Math.max(peak, ++total);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active[id] = active[id]! - 1;
          total--;
        }, configs[id]),
      ),
    );
    expect(peak).toBe(2);
  });

  it("releases admission after a rejected attempt", async () => {
    const limit = createExecutionLimit(1);
    const results = await Promise.allSettled([
      limit(async () => {
        throw new Error("expected");
      }),
      limit(async () => "next"),
    ]);
    expect(results).toMatchObject([{ status: "rejected" }, { status: "fulfilled", value: "next" }]);
  });
});

describe("checkpointed map collection compatibility", () => {
  it("can finish a map saved with legacy array bags", () => {
    const result = reduceMapCollect(
      { fan: [{ i: 0, v: "finished" }] },
      { fan: [{ i: 1, v: "resumed" }] },
    );
    expect(result.fan).toEqual([
      { i: 0, v: "finished" },
      { i: 1, v: "resumed" },
    ]);
  });

  it("rejects stale round writes and replaces duplicate item writes", () => {
    let result = reduceMapCollect(
      { fan: [{ i: 0, v: "old" }] },
      { fan: { round: "new", items: [], reset: true } },
    );
    result = reduceMapCollect(result, { fan: { round: "old", items: [{ i: 0, v: "stale" }] } });
    result = reduceMapCollect(result, { fan: { round: "new", items: [{ i: 0, v: "value" }] } });
    result = reduceMapCollect(result, { fan: { round: "new", items: [{ i: 0, v: "updated" }] } });
    expect(result.fan).toEqual({ round: "new", items: [{ i: 0, v: "updated" }] });
  });
});
