import { describe, expect, it } from "vitest";
import {
  initialRunActivity,
  updateRunActivity,
  settleRunActivity,
  resolveRunLabels,
  parseRunActivity,
} from "./run-activity.js";

const at = "2026-11-13T12:00:00.000Z";
const later = "2026-11-13T12:01:00.000Z";
describe("compact run activity", () => {
  it("tracks parallel declared steps and ignores tokens, nested lifecycles, and internal tools", () => {
    let activity = initialRunActivity("running", at);
    for (const nodeId of ["a", "b"])
      activity = updateRunActivity(activity, { type: "node.start", ts: at, scope: { nodeId } }, [
        "a",
        "b",
      ]);
    expect(activity.currentNodes).toEqual(["a", "b"]);
    for (const event of [
      { type: "run.end", scope: { parentSpanId: "parent" } },
      { type: "node.start", scope: { nodeId: "tool" } },
      { type: "node.token", scope: { nodeId: "a" } },
    ])
      expect(updateRunActivity(activity, { ...event, ts: later }, ["a", "b"])).toBe(activity);
    expect(
      updateRunActivity(activity, { type: "node.end", ts: later, scope: { nodeId: "a" } })
        .currentNodes,
    ).toEqual(["b"]);
  });
  it("distinguishes human, external, mixed, and unknown interrupts without inspecting domain payloads", () => {
    const previous = initialRunActivity("running", at);
    for (const [kinds, waitingOn] of [
      [["approval"], "you"],
      [["custom"], "external"],
      [["approval", "custom"], "both"],
      [["future"], "unknown"],
    ] as const) {
      const activity = settleRunActivity(previous, "interrupted", later, {
        next: ["a", "b"],
        interrupts: kinds.map((kind) => ({ kind })),
      });
      expect(activity).toMatchObject({
        phase: "interrupted",
        currentNodes: ["a", "b"],
        waitingOn,
        stateSince: later,
      });
      expect(
        settleRunActivity(activity, "interrupted", "2026-11-14T12:00:00Z", {
          next: ["b", "a"],
          interrupts: kinds.map((kind) => ({ kind })),
        }),
      ).toBe(activity);
    }
  });
  it("records paused checkpoints and clears waits and steps when execution completes", () => {
    const paused = settleRunActivity(initialRunActivity("running", at), "paused", later, {
      next: ["next"],
    });
    expect(paused).toMatchObject({ phase: "paused", currentNodes: ["next"], waitingOn: "you" });
    expect(settleRunActivity(paused, "completed", later)).toMatchObject({
      phase: "completed",
      currentNodes: [],
      waitingOn: null,
    });
  });
  it("resolves only graph-declared labels from public input and excludes invalid values", () => {
    expect(
      resolveRunLabels(
        { customer: "{{ input.customer }}", category: "content", missing: "{{ secrets.token }}" },
        { customer: "Acme", secret: "never implicitly exposed" },
        "thread",
      ),
    ).toMatchObject({ customer: "Acme", category: "content" });
    expect(Object.keys(resolveRunLabels(undefined, { customer: "Acme" }, "thread"))).toEqual([]);
  });
  it("rejects malformed persisted activity", () => {
    expect(
      parseRunActivity({ phase: "running", currentNodes: [], stateSince: "bad" }),
    ).toBeUndefined();
    expect(parseRunActivity(initialRunActivity("paused", at))).toEqual(
      initialRunActivity("paused", at),
    );
  });
});
