import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRest } from "./rest.js";
import { credentialStatus } from "../credentials.js";
import type { RunService } from "../run-service.js";

function mockRes(): ServerResponse & { statusCode?: number; body?: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(payload: string) {
      this.body = JSON.parse(payload);
    },
  };
  return res as unknown as ServerResponse & { statusCode?: number; body?: unknown };
}

describe("GET /healthz", () => {
  it("includes credentials introspection", async () => {
    const service = {
      registry: { activeCount: () => 0 },
      metrics: { snapshot: () => ({}) },
      config: { databaseUrl: undefined },
    } as unknown as RunService;
    const req = { method: "GET" } as IncomingMessage;
    const res = mockRes();
    const handled = await handleRest(req, res, service, new URL("http://localhost/healthz"));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok?: boolean;
      credentials?: ReturnType<typeof credentialStatus>;
    };
    expect(body.ok).toBe(true);
    expect(body.credentials).toEqual(credentialStatus());
    expect(body.credentials).toEqual(
      expect.objectContaining({
        hasAwsKeys: expect.any(Boolean),
        hasBedrockIamHint: expect.any(Boolean),
        vendorKeys: expect.any(Array),
      }),
    );
    expect(
      body.credentials?.awsRegion === null || typeof body.credentials?.awsRegion === "string",
    ).toBe(true);
  });
});
