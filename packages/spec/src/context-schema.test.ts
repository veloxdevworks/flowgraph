import { describe, it, expect } from "vitest";
import { AgentWithSchema, RuntimeSchema, AgentContextSchema } from "./index.js";

describe("agent with.context schema", () => {
  const agent = (context: unknown) => AgentWithSchema.safeParse({ prompt: "p", context });

  it("accepts every strategy and keeps unset fields unset", () => {
    for (const strategy of ["none", "last", "trim", "summarize"]) {
      const r = agent({ strategy, maxTokens: 8000 });
      expect(r.success).toBe(true);
    }
    const r = AgentContextSchema.parse({ history: "chat" });
    expect(r).toEqual({ history: "chat" });
  });

  it("accepts the full shape", () => {
    const r = agent({
      history: "chat",
      maxTokens: 8000,
      reserveTokens: 500,
      strategy: "summarize",
      lastN: 10,
      toolResultMaxTokens: 2000,
      summarize: { mode: "model", provider: "cheap", model: "mini", maxTokens: 300, instructions: "be brief" },
      issuesMaxTokens: 400,
      estimator: "bytes",
      onOverflow: "warn",
      record: "all",
      compact: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown keys, bad strategies and non-positive budgets", () => {
    expect(agent({ maxToken: 10 }).success).toBe(false);
    const bad = agent({ strategy: "window" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("none | last | trim | summarize");
    expect(agent({ maxTokens: 0 }).success).toBe(false);
    expect(agent({ summarize: { model: "x", extra: 1 } }).success).toBe(false);
    expect(agent({ record: "everything" }).success).toBe(false);
    expect(agent({ summarize: { mode: "abstract" } }).success).toBe(false);
    expect(agent({ issuesMaxTokens: 0 }).success).toBe(false);
  });
});

describe("runtime.context schema", () => {
  it("accepts graph defaults without history", () => {
    const r = RuntimeSchema.parse({ context: { maxTokens: 32000, strategy: "trim", toolResultMaxTokens: 4000 } });
    expect(r.context).toEqual({ maxTokens: 32000, strategy: "trim", toolResultMaxTokens: 4000 });
  });

  it("rejects per-agent-only keys", () => {
    expect(RuntimeSchema.safeParse({ context: { history: "chat" } }).success).toBe(false);
  });
});
