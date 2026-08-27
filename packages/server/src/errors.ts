export class TooManyRunsError extends Error {
  constructor(readonly max: number) {
    super(`Too many concurrent runs (max ${max}). Retry after an in-flight run finishes.`);
    this.name = "TooManyRunsError";
  }
}
