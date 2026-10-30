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
  ) {
    super(message);
    this.name = "ServerRequestError";
  }
}

/** The status and code to answer with for a refusal, or undefined for other errors. */
export function refusalOf(err: unknown): { status: number; code: string; diagnostics?: unknown[] } | undefined {
  if (err instanceof ServerRequestError) return { status: err.status, code: err.code, ...(err.diagnostics ? { diagnostics: err.diagnostics } : {}) };
  if (err instanceof NodePolicyError) return { status: 403, code: err.code };
  return undefined;
}
