import { describe, expect, it } from "vitest";
import { GraphSpecSchema, RouterWithSchema, WaitWithSchema } from "./index.js";

const graph = (edges: unknown[], nodes: unknown[] = [{ id: "a", type: "function" }, { id: "b", type: "function" }]) =>
  GraphSpecSchema.safeParse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "routes" },
    nodes,
    edges,
  });

describe("branch entries", () => {
  it("requires exactly one of when or default", () => {
    expect(graph([{ from: "a", branch: [{ to: "b" }] }]).success).toBe(false);
    expect(graph([{ from: "a", branch: [{ when: "{{ true }}", default: true, to: "b" }] }]).success).toBe(false);
    expect(graph([{ from: "a", branch: [{ when: "{{ true }}", to: "b" }, { default: true, to: "a" }] }]).success).toBe(true);
    expect(graph([{ from: "a", branch: [{ default: true, to: "a" }, { default: true, to: "b" }] }]).success).toBe(false);
  });

  it("accepts fan-out through to", () => {
    expect(graph([{ from: "a", to: ["a", "b"] }, { from: "b", to: "END" }]).success).toBe(true);
  });
});

describe("router route lists", () => {
  it("keeps list order and rejects a route object", () => {
    const listed = RouterWithSchema.safeParse({
      routes: [
        { when: "{{ false }}", to: "a" },
        { default: true, to: "b" },
      ],
    });
    expect(listed.success).toBe(true);
    expect(RouterWithSchema.safeParse({ routes: { a: { to: "a", default: true } } }).success).toBe(false);
  });

  it("requires a name on model routes and when or default on rule routes", () => {
    expect(RouterWithSchema.safeParse({ mode: "model", input: "text", routes: [{ to: "a" }] }).success).toBe(false);
    expect(
      RouterWithSchema.safeParse({
        mode: "model",
        input: "text",
        routes: [{ name: "a", to: "left" }, { name: "b", default: true, to: "right" }],
      }).success,
    ).toBe(true);
    expect(RouterWithSchema.safeParse({ routes: [{ to: "a" }] }).success).toBe(false);
  });
});

describe("hook events and verbs", () => {
  const spec = (hook: unknown) =>
    GraphSpecSchema.safeParse({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "hooks" },
      nodes: [{ id: "a", type: "function" }],
      edges: [{ from: "START", to: "a" }],
      runtime: { hooks: [hook] },
    });

  it("rejects events that do not run and verbs that do not apply", () => {
    expect(spec({ on: "skill:beforeRun", do: "allow" }).success).toBe(false);
    expect(spec({ on: "node:before", do: "continue" }).success).toBe(false);
    expect(spec({ on: "node:error", do: "deny" }).success).toBe(false);
    expect(spec({ on: "node:error", do: "ignore" }).success).toBe(false);
    expect(spec({ on: "node:before", do: "deny" }).success).toBe(true);
    expect(spec({ on: "node:error", do: "continue" }).success).toBe(true);
    expect(spec({ on: "node:error", do: "fail" }).success).toBe(true);
    expect(spec({ on: "agent:beforeToolCall", do: "allow" }).success).toBe(true);
    expect(spec({ on: "intelligent:beforeToolCall", do: "deny" }).success).toBe(true);
  });

  it("rejects an unknown where key", () => {
    const parsed = spec({ on: "node:before", do: "deny", where: { nodeId: "a", typo: true } });
    expect(parsed.success).toBe(false);
  });
});

describe("wait deadline", () => {
  it("renames duration to deadline and keeps signal", () => {
    expect(WaitWithSchema.safeParse({ deadline: "1ms", signal: "ready" }).success).toBe(true);
    const renamed = WaitWithSchema.safeParse({ duration: "1ms" });
    expect(renamed.success).toBe(false);
    expect(renamed.error?.issues.some((issue) => issue.message.includes("deadline"))).toBe(true);
  });
});
