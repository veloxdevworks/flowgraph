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
    /** With `requireCoverage`, a full (non-partial) output also needs every agenda item covered. */
    agenda?: readonly { id: string; title?: string }[] | undefined;
    coverage?: Record<string, unknown> | undefined;
    requireCoverage?: boolean | undefined;
  },
): WorkshopOutputCheck {
  const label = opts.label ?? "workshop output";
  let fullError: string;
  try {
    validateJsonSchema(output, opts.schema, label);
    const uncovered = opts.requireCoverage ? uncoveredAgendaItems(opts.agenda, opts.coverage) : [];
    if (uncovered.length === 0) return { complete: true };
    fullError = `${label}: agenda item(s) not covered: ${uncovered.join(", ")}`;
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

/** Agenda ids whose `coverage` entry is missing or falsy. */
export function uncoveredAgendaItems(
  agenda: readonly { id: string }[] | undefined,
  coverage: Record<string, unknown> | undefined,
): string[] {
  return (agenda ?? []).filter((item) => !coverage?.[item.id]).map((item) => item.id);
}
