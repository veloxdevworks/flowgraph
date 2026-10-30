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
