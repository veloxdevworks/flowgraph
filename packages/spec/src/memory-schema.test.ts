import { describe, it, expect } from "vitest";
import { MemoryWithSchema, RuntimeSchema } from "./schema.js";

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
