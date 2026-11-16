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

  it("rejects config.defaults.retry and names runtime.retry or the node's retry", () => {
    const d = graphDiags(base({ config: { defaults: { retry: { maxAttempts: 5 } } } }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      severity: "error",
      code: "SCHEMA_ERROR",
      path: "config.defaults.retry",
    });
    expect(d[0]!.message).toContain("config.defaults.retry is not supported");
    expect(d[0]!.message).toContain("runtime.retry");
    expect(d[0]!.message).toContain("retry on the node");
  });

  it("rejects config.defaults.timeout and names runtime.timeoutDefault or the node's timeout", () => {
    const d = graphDiags(base({ config: { defaults: { timeout: "30s" } } }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      severity: "error",
      code: "SCHEMA_ERROR",
      path: "config.defaults.timeout",
    });
    expect(d[0]!.message).toContain("config.defaults.timeout is not supported");
    expect(d[0]!.message).toContain("runtime.timeoutDefault");
    expect(d[0]!.message).toContain("timeout on the node");
  });

  it("rejects http with.retry and names the node's retry or runtime.retry", () => {
    const r = HttpWithSchema.safeParse({
      url: "https://example.com",
      retry: { maxAttempts: 4 },
    });
    expect(r.success).toBe(false);
    const issue = r.error?.issues.find((i) => i.path.join(".") === "retry");
    expect(issue?.message).toContain("http with.retry is not supported");
    expect(issue?.message).toContain("retry on the node");
    expect(issue?.message).toContain("runtime.retry");
  });

  it("rejects http with.timeout and names the node's timeout or runtime.timeoutDefault", () => {
    const r = HttpWithSchema.safeParse({
      url: "https://example.com",
      timeout: "200ms",
    });
    expect(r.success).toBe(false);
    const issue = r.error?.issues.find((i) => i.path.join(".") === "timeout");
    expect(issue?.message).toContain("http with.timeout is not supported");
    expect(issue?.message).toContain("timeout on the node");
    expect(issue?.message).toContain("runtime.timeoutDefault");
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
