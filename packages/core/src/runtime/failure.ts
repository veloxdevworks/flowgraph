/** An intentional failure ending, distinct from a recoverable node error. */
export class FlowFailureError extends Error {
  readonly code = "FLOW_FAILED";
  readonly retryable = false;
  constructor(readonly reason: string) {
    super(reason);
    this.name = "FlowFailureError";
  }
}

export function flowFailure(error: unknown): FlowFailureError | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    if (current instanceof FlowFailureError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
