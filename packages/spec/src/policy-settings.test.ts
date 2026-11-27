import { describe, it, expect } from "vitest";
import { GraphSpecSchema, HttpWithSchema, diagnosticsFromZodIssues } from "./index.js";

const base = (over: Record<string, unknown> = {}) => ({
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "g" },
  nodes: [{ id: "fetch", type: "http", with: { url: "https://example.com" } }],
  edges: [
    { from: "START", to: "fetch" },
    { from: "fetch", to: "END" },
  ],
  ...over,
});

function graphDiags(spec: unknown) {
  const r = GraphSpecSchema.safeParse(spec);
  if (r.success) return [];
  return diagnosticsFromZodIssues(r.error.issues, spec);
}

describe("retry and timeout have one canonical place", () => {
  it("accepts runtime.retry, runtime.timeoutDefault, and node retry/timeout", () => {
    const spec = base({
      runtime: { retry: { maxAttempts: 3 }, timeoutDefault: "30s" },
      nodes: [
        {
          id: "fetch",
          type: "http",
          retry: { maxAttempts: 5 },
          timeout: "2s",
          with: { url: "https://example.com" },
        },
      ],
    });
    expect(GraphSpecSchema.safeParse(spec).success).toBe(true);
    expect(graphDiags(spec)).toEqual([]);
  });

  it("rejects config.defaults.retry as an unrecognized key", () => {
    const d = graphDiags(base({ config: { defaults: { retry: { maxAttempts: 5 } } } }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      severity: "error",
      code: "UNKNOWN_FIELD",
      path: "config.defaults.retry",
    });
    expect(d[0]!.message).toContain("retry");
  });

  it("rejects config.defaults.timeout as an unrecognized key", () => {
    const d = graphDiags(base({ config: { defaults: { timeout: "30s" } } }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      severity: "error",
      code: "UNKNOWN_FIELD",
      path: "config.defaults.timeout",
    });
    expect(d[0]!.message).toContain("timeout");
  });

  it("rejects http with.retry as an unknown field", () => {
    const r = HttpWithSchema.safeParse({
      url: "https://example.com",
      retry: { maxAttempts: 4 },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes("retry"))).toBe(true);
  });

  it("rejects http with.timeout as an unknown field", () => {
    const r = HttpWithSchema.safeParse({
      url: "https://example.com",
      timeout: "200ms",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes("timeout"))).toBe(true);
  });

  it("still accepts http with.url and expect without retry or timeout", () => {
    expect(
      HttpWithSchema.safeParse({
        url: "https://example.com",
        method: "GET",
        expect: { status: [200] },
      }).success,
    ).toBe(true);
  });
});
