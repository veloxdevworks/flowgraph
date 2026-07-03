import { describe, it, expect } from "vitest";
import { createRedactor, redactingSink, DEFAULT_REDACT_PATTERNS } from "../src/secrets.js";

describe("createRedactor", () => {
  it("redacts known secret strings", () => {
    const redact = createRedactor(["super-secret-token-abc123"]);
    expect(redact("Auth: super-secret-token-abc123")).toBe("Auth: [REDACTED]");
  });

  it("does not redact short strings", () => {
    const redact = createRedactor(["abc"]);
    expect(redact("abc")).toBe("abc");
  });

  it("redacts recursively in objects", () => {
    const redact = createRedactor(["mysecret12345"]);
    const result = redact({ headers: { Authorization: "Bearer mysecret12345" } }) as Record<string, unknown>;
    const headers = result["headers"] as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer [REDACTED]");
  });

  it("redacts in arrays", () => {
    const redact = createRedactor(["token-xyz-123456"]);
    const result = redact(["hello", "token-xyz-123456"]) as string[];
    expect(result[1]).toBe("[REDACTED]");
  });

  it("applies pattern redaction", () => {
    const redact = createRedactor([], DEFAULT_REDACT_PATTERNS);
    const result = redact("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig");
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiJ9");
  });
});

describe("redactingSink", () => {
  it("passes events with redacted data to inner sink", () => {
    const captured: unknown[] = [];
    const inner = (ev: { data: unknown }) => { captured.push(ev.data); };
    const redact = createRedactor(["my-api-key-secret-xyz"]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = redactingSink(inner as any, redact);
    wrapped({
      id: "1", type: "node.output", ts: "", runId: "r1", graph: "g", scope: {}, seq: 0,
      data: { apiKey: "my-api-key-secret-xyz" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect((captured[0] as Record<string, string>)["apiKey"]).toBe("[REDACTED]");
  });
});
