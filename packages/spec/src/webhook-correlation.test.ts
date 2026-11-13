import { describe, expect, it } from "vitest";
import { RuntimeSchema, WaitWithSchema } from "./schema.js";

describe("webhook correlation configuration", () => {
  it("accepts run and gate declarations plus a signed ingress", () => {
    expect(
      RuntimeSchema.parse({
        correlation: { opaque: "{{ input.external }}" },
        webhookServer: {
          ingress: {
            id: "integration-1",
            signingSecretEnv: "WEBHOOK_KEY",
            journalPath: ".flowgraph/receipts",
          },
        },
      }),
    ).toMatchObject({ correlation: { opaque: "{{ input.external }}" } });
    expect(WaitWithSchema.parse({ webhook: { correlation: { stage: "second" } } })).toMatchObject({
      webhook: { correlation: { stage: "second" } },
    });
  });

  it("rejects invalid ingress namespaces and incomplete signing configuration", () => {
    for (const id of ["", "../other", "name/other", "x".repeat(65)]) {
      expect(
        RuntimeSchema.safeParse({
          webhookServer: { ingress: { id, signingSecretEnv: "KEY", journalPath: "receipts" } },
        }).success,
      ).toBe(false);
    }
    expect(
      RuntimeSchema.safeParse({
        webhookServer: { ingress: { id: "test", journalPath: "receipts" } },
      }).success,
    ).toBe(false);
    expect(WaitWithSchema.safeParse({ webhook: { correlation: { opaque: 42 } } }).success).toBe(
      false,
    );
  });
});
