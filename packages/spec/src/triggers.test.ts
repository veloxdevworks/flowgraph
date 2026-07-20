import { describe, expect, it } from "vitest";
import { GraphSpecSchema, TriggerSchema } from "./schema.js";

const minimalGraph = {
  apiVersion: "flowgraph/v1" as const,
  kind: "Graph" as const,
  metadata: { name: "trig-graph" },
  nodes: [{ id: "n1", type: "function" as const, with: { fn: "x" } }],
  edges: [
    { from: "START", to: "n1" },
    { from: "n1", to: "END" },
  ],
};

describe("TriggerSchema", () => {
  it("accepts cron trigger", () => {
    const result = TriggerSchema.safeParse({
      id: "nightly",
      type: "cron",
      schedule: "0 2 * * *",
      timezone: "America/Denver",
    });
    expect(result.success).toBe(true);
  });

  it("accepts interval trigger", () => {
    const result = TriggerSchema.safeParse({
      id: "poll",
      type: "interval",
      every: 15,
      unit: "minutes",
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts startup trigger", () => {
    const result = TriggerSchema.safeParse({ id: "boot", type: "startup" });
    expect(result.success).toBe(true);
  });

  it("accepts flow-complete and flow-failed", () => {
    expect(
      TriggerSchema.safeParse({
        id: "after-a",
        type: "flow-complete",
        graph: "upstream-graph",
      }).success,
    ).toBe(true);
    expect(
      TriggerSchema.safeParse({
        id: "on-fail",
        type: "flow-failed",
        graph: "upstream-graph",
      }).success,
    ).toBe(true);
  });

  it("rejects non-kebab graph name on flow-complete", () => {
    const result = TriggerSchema.safeParse({
      id: "bad",
      type: "flow-complete",
      graph: "NotKebab",
    });
    expect(result.success).toBe(false);
  });

  it("accepts webhook and file-watch", () => {
    expect(
      TriggerSchema.safeParse({
        id: "hook",
        type: "webhook",
        path: "/hooks/trig-graph",
      }).success,
    ).toBe(true);
    expect(
      TriggerSchema.safeParse({
        id: "watch",
        type: "file-watch",
        path: "/tmp/inbox",
        events: ["create", "change"],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown trigger type", () => {
    const result = TriggerSchema.safeParse({ id: "x", type: "email" });
    expect(result.success).toBe(false);
  });
});

describe("GraphSpecSchema.triggers", () => {
  it("allows omitting triggers", () => {
    const result = GraphSpecSchema.safeParse(minimalGraph);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triggers).toBeUndefined();
    }
  });

  it("round-trips a mixed triggers array", () => {
    const result = GraphSpecSchema.safeParse({
      ...minimalGraph,
      triggers: [
        { id: "boot", type: "startup" },
        { id: "nightly", type: "cron", schedule: "0 3 * * 1" },
        { id: "poll", type: "interval", every: 5, unit: "minutes" },
        { id: "after", type: "flow-complete", graph: "other-flow" },
        { id: "on-fail", type: "flow-failed", graph: "other-flow" },
        { id: "hook", type: "webhook" },
        { id: "watch", type: "file-watch", path: "./data" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triggers).toHaveLength(7);
      expect(result.data.triggers?.[0]?.type).toBe("startup");
      expect(result.data.triggers?.[1]).toMatchObject({
        type: "cron",
        schedule: "0 3 * * 1",
      });
    }
  });
});
