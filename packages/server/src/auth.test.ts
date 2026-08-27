import { describe, expect, it } from "vitest";
import { AUTH_REQUIRED_MESSAGE, checkBearerAuth } from "./auth.js";
import type { IncomingMessage } from "node:http";

function req(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

describe("checkBearerAuth", () => {
  it("refuses REST when no token is configured and auth is not disabled", () => {
    const result = checkBearerAuth(req(), { authDisabled: false });
    expect(result).toEqual({ ok: false, status: 401, message: AUTH_REQUIRED_MESSAGE });
  });

  it("allows all requests when auth is explicitly disabled", () => {
    expect(checkBearerAuth(req(), { authDisabled: true })).toEqual({ ok: true });
  });

  it("requires a matching bearer token when configured", () => {
    expect(checkBearerAuth(req(), { authToken: "secret" })).toEqual({
      ok: false,
      status: 401,
      message: "Missing Authorization header",
    });
    expect(checkBearerAuth(req("Bearer nope"), { authToken: "secret" })).toEqual({
      ok: false,
      status: 401,
      message: "Invalid bearer token",
    });
    expect(checkBearerAuth(req("Bearer secret"), { authToken: "secret" })).toEqual({ ok: true });
  });
});
