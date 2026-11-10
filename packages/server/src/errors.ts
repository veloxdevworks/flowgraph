import { NodePolicyError } from "@flowgraph/core";

export class TooManyRunsError extends Error {
  constructor(readonly max: number) {
    super(`Too many concurrent runs (max ${max}). Retry after an in-flight run finishes.`);
    this.name = "TooManyRunsError";
  }
}

/** A request the server refuses with a specific HTTP status and machine-readable code. */
export class ServerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly diagnostics?: unknown[],
    /** Extra machine-readable fields merged into the response body (e.g. THREAD_EXISTS). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServerRequestError";
  }
}

/** The HTTP status, code and body fields (`extra`, merged into the body) for a refusal, or undefined for other errors. */
export function refusalOf(err: unknown): { status: number; code: string; diagnostics?: unknown[]; extra?: Record<string, unknown> } | undefined {
  if (err instanceof ServerRequestError) {
    return {
      status: err.status,
      code: err.code,
      ...(err.diagnostics ? { diagnostics: err.diagnostics } : {}),
      ...(err.extra ? { extra: err.extra } : {}),
    };
  }
  if (err instanceof NodePolicyError) return { status: 403, code: err.code };
  return undefined;
}
