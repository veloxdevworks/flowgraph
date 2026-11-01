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

/**
 * The graph store could not be written or read (disk full, permissions, an
 * I/O error). The client gets 503 with a code and a message naming only the
 * thread; the file path and errno go to the server log, never to the client.
 */
export class GraphStoreError extends ServerRequestError {
  constructor(
    readonly op: "write" | "read",
    readonly threadId: string,
    cause: unknown,
  ) {
    super(
      503,
      op === "write" ? "GRAPH_STORE_WRITE_FAILED" : "GRAPH_STORE_READ_FAILED",
      `The graph store could not ${op === "write" ? "save" : "read"} thread "${threadId}"; try again later`,
    );
    this.name = "GraphStoreError";
    this.cause = cause;
  }
}

/**
 * True for an error from a system call (file system, network). Its message
 * names server paths or addresses, so it is logged and never sent to a client.
 */
export function isSystemError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as NodeJS.ErrnoException;
  return typeof e.code === "string" && (typeof e.syscall === "string" || typeof e.errno === "number" || typeof e.path === "string");
}

/** What a client sees for a system error: its detail stays in the server log. */
export const INTERNAL_ERROR_BODY = { error: "Internal server error", code: "INTERNAL_ERROR" } as const;

/**
 * Status and body for an error that is not a refusal. A system error (its
 * message names server paths) answers 500 with {@link INTERNAL_ERROR_BODY}.
 * Other errors keep their message, as before: 400 for request mistakes
 * (`threadId is required`, `No persisted graph ...`), else 500. No stack
 * trace is ever sent.
 */
export function unexpectedError(err: unknown): { status: number; body: { error: string; code?: string } } {
  if (isSystemError(err)) return { status: 500, body: { ...INTERNAL_ERROR_BODY } };
  const message = err instanceof Error ? err.message : String(err);
  return { status: /required|Invalid|No persisted|No active/i.test(message) ? 400 : 500, body: { error: message } };
}
