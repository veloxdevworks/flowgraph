import { describe, it, expect } from "vitest";
import { RuntimeSchema } from "./schema.js";

describe("runtime backend enums", () => {
  it("accepts the known checkpoint and store backends", () => {
    for (const backend of ["memory", "sqlite", "postgres"]) {
      expect(RuntimeSchema.safeParse({ checkpoint: { backend } }).success).toBe(true);
    }
    for (const backend of ["memory", "none", "sqlite", "postgres"]) {
      expect(RuntimeSchema.safeParse({ store: { backend } }).success).toBe(true);
    }
  });

  it("rejects an unknown checkpoint backend with a clear message", () => {
    const r = RuntimeSchema.safeParse({ checkpoint: { backend: "redis" } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/must be one of memory \| sqlite \| postgres \(got "redis"\)/);
  });

  it("rejects an unknown store backend with a clear message", () => {
    const r = RuntimeSchema.safeParse({ store: { backend: "dynamo" } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/must be one of memory \| none \| sqlite \| postgres \(got "dynamo"\)/);
  });

  it("defaults store backend to memory", () => {
    const r = RuntimeSchema.parse({ store: {} });
    expect(r.store?.backend).toBe("memory");
  });
});
