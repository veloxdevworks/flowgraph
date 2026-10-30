import { describe, it, expect } from "vitest";
import { AgentWithSchema, MemoryWithSchema, RuntimeSchema } from "./schema.js";

describe("runtime.memory schema", () => {
  it("defaults backend to checkpoint and subject ttl to 180d", () => {
    const r = RuntimeSchema.parse({ memory: { subject: { type: "incident", key: "{{ input.fp }}" } } });
    expect(r.memory).toMatchObject({ backend: "checkpoint", subject: { type: "incident", required: false, ttl: "180d", hash: false } });
  });

  it("rejects unknown keys, bad backends and bad subject types", () => {
    expect(RuntimeSchema.safeParse({ memory: { backnd: "checkpoint" } }).success).toBe(false);
    const bad = RuntimeSchema.safeParse({ memory: { backend: "redis" } });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("checkpoint | memory");
    expect(RuntimeSchema.safeParse({ memory: { subject: { type: "Bad Type", key: "x" } } }).success).toBe(false);
  });

  it("memory node `with` requires key and value where needed", () => {
    expect(MemoryWithSchema.safeParse({ op: "get", key: "k" }).success).toBe(true);
    expect(MemoryWithSchema.safeParse({ op: "search", prefix: "fix/" }).success).toBe(true);
    expect(MemoryWithSchema.safeParse({ op: "get" }).success).toBe(false);
    expect(MemoryWithSchema.safeParse({ op: "put", key: "k" }).success).toBe(false);
    expect(MemoryWithSchema.safeParse({ op: "get", key: "k", scope: "graph", scopes: ["user"] }).success).toBe(false);
    expect(MemoryWithSchema.safeParse({ op: "put", key: "k", value: 1, scope: "team" }).success).toBe(false);
  });
});

describe("agent with.memory schema", () => {
  const agent = (memory: unknown) => AgentWithSchema.safeParse({ prompt: "p", memory });

  it("accepts recall blocks, similarSubjects and agentWrites", () => {
    const r = agent({
      maxTokens: 1200,
      recall: [
        { id: "thisIncident", scopes: ["subject"], prefix: "attempt/", limit: 10 },
        { id: "priorFixes", similarSubjects: { type: "incident", match: { service: "{{ state.svc }}" }, where: { outcome: "resolved" }, limit: 5, perSubject: 2 }, onError: "skip" },
      ],
      agentWrites: { scopes: ["subject", "user"], maxPerRun: 5 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects bad ids, unknown keys, out-of-range limits and mixed block kinds", () => {
    expect(agent({ recall: [{ id: "has-dash" }] }).success).toBe(false);
    expect(agent({ recall: [{ id: "a", scope: "user" }] }).success).toBe(false);
    expect(agent({ recall: [{ id: "a", limit: 500 }] }).success).toBe(false);
    expect(agent({ recall: [{ id: "a", similarSubjects: { perSubject: 50 } }] }).success).toBe(false);
    expect(agent({ recall: [{ id: "a", scopes: ["org"], similarSubjects: {} }] }).success).toBe(false);
    expect(agent({ agentWrites: { scopes: [] } }).success).toBe(false);
    expect(agent({ agentWrites: { scopes: ["team"] } }).success).toBe(false);
    expect(agent({ budget: 3 }).success).toBe(false);
  });
});
