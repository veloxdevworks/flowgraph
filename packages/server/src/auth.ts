import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

export const AUTH_REQUIRED_MESSAGE =
  "Authentication required. Set FLOWGRAPH_AUTH_TOKEN or FLOWGRAPH_AUTH_DISABLED=1 for local/dev.";

/**
 * Pluggable bearer-token auth for the generic REST path.
 *
 * Auth is required by default. Operators must set `FLOWGRAPH_AUTH_TOKEN`, or
 * explicitly opt out with `FLOWGRAPH_AUTH_DISABLED=1` (local/dev only).
 */
export function checkBearerAuth(
  req: IncomingMessage,
  opts: { authToken?: string | undefined; authDisabled?: boolean | undefined },
): AuthResult {
  if (opts.authDisabled) return { ok: true };
  if (!opts.authToken) {
    return { ok: false, status: 401, message: AUTH_REQUIRED_MESSAGE };
  }

  const header = req.headers.authorization;
  if (!header) {
    return { ok: false, status: 401, message: "Missing Authorization header" };
  }
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m?.[1] || m[1] !== opts.authToken) {
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
