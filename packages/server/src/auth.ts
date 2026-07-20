import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

/**
 * Pluggable bearer-token auth for the generic REST path.
 * When `authToken` is unset/empty, all requests are allowed (local/dev).
 */
export function checkBearerAuth(
  req: IncomingMessage,
  authToken: string | undefined,
): AuthResult {
  if (!authToken) return { ok: true };

  const header = req.headers.authorization;
  if (!header) {
    return { ok: false, status: 401, message: "Missing Authorization header" };
  }
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m?.[1] || m[1] !== authToken) {
    return { ok: false, status: 401, message: "Invalid bearer token" };
  }
  return { ok: true };
}

/** AgentCore `/invocations` and `/ping` skip bearer auth (AWS SigV4 at the edge). */
export function isAgentCorePath(pathname: string): boolean {
  return pathname === "/ping" || pathname === "/invocations";
}

export function writeUnauthorized(res: ServerResponse, message: string): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
