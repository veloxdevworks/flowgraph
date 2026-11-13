import type { Diagnostic } from "@flowgraph/spec";
import type { PlacementDecision } from "./resolve.js";

export class PlacementUnsatisfiedError extends Error {
  readonly code = "PLACEMENT_UNSATISFIED";
  constructor(
    message: string,
    readonly decisions: PlacementDecision[],
    readonly diagnostics: Diagnostic[],
  ) {
    super(message);
    this.name = "PlacementUnsatisfiedError";
  }
}
