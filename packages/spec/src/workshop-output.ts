/**
 * The one rule for whether a workshop output can be accepted. The engine applies it
 * on resume; clients apply it before ending a session, so a session is not closed
 * on an output the engine would reject.
 */

import { validateJsonSchema } from "./validate-json-schema.js";

/** End reasons that may carry an unfinished output when the node sets `allowPartial`. */
export const WORKSHOP_PARTIAL_END_REASONS: readonly string[] = ["human_ended", "timeout", "skipped"];

export type WorkshopOutputCheck = {
  /** Satisfies the whole schema. */
  complete: boolean;
  /** Why the output cannot be accepted; absent when it can. */
  error?: string;
};

export function checkWorkshopOutput(
  output: unknown,
  opts: {
    schema?: Record<string, unknown> | undefined;
    endedReason?: string | undefined;
    allowPartial?: boolean | undefined;
    label?: string | undefined;
  },
): WorkshopOutputCheck {
  const label = opts.label ?? "workshop output";
  let fullError: string;
  try {
    validateJsonSchema(output, opts.schema, label);
    return { complete: true };
  } catch (err) {
    fullError = err instanceof Error ? err.message : String(err);
  }
  if (!opts.allowPartial || !WORKSHOP_PARTIAL_END_REASONS.includes(opts.endedReason ?? "")) {
    return { complete: false, error: fullError };
  }
  try {
    validateJsonSchema(output, opts.schema, label, { ignoreRequired: true });
    return { complete: false };
  } catch (err) {
    return { complete: false, error: err instanceof Error ? err.message : String(err) };
  }
}
