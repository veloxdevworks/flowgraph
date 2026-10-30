/**
 * Re-prompting HITL interrupts.
 *
 * LangGraph persists every resume value a task consumed, indexed by the order
 * of `interrupt()` calls inside the node. If a node throws after a bad resume,
 * the bad value is replayed on every later resume and the thread is stuck.
 *
 * `interruptUntilValid` instead re-issues the interrupt (a new interrupt
 * index) with the validation error attached, so the next resume value is
 * consumed fresh. After `maxAttempts` rejected answers the interrupt is raised
 * once more with `exhausted: true`; the engine turns that into a run error
 * while leaving the interrupt pending, so the thread stays inspectable and a
 * later valid resume still completes the node.
 */

import type { InterruptKind, NodeRunContext } from "../context.js";

export const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

export type ResumeValidationInfo = {
  validationError: string;
  /** Number of rejected answers so far (1-based). */
  attempt: number;
  maxAttempts: number;
  /** True once `attempt >= maxAttempts`; the run fails but the interrupt stays pending. */
  exhausted: boolean;
};

export function interruptUntilValid<T>(
  ctx: Pick<NodeRunContext, "interrupt">,
  payload: { reason: string; kind?: InterruptKind; data: Record<string, unknown> },
  parse: (resume: unknown) => T,
  opts: { maxAttempts?: number | undefined },
): T {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS));
  let rejected = 0;
  let last: ResumeValidationInfo | undefined;
  // Each loop iteration is a distinct interrupt index, so replays consume the
  // persisted answers in order and a new resume lands on the newest prompt.
  while (true) {
    const resume = ctx.interrupt<unknown>({
      reason: payload.reason,
      ...(payload.kind ? { kind: payload.kind } : {}),
      data: last ? { ...payload.data, ...last } : payload.data,
    });
    try {
      return parse(resume);
    } catch (err) {
      rejected += 1;
      last = {
        validationError: err instanceof Error ? err.message : String(err),
        attempt: rejected,
        maxAttempts,
        exhausted: rejected >= maxAttempts,
      };
    }
  }
}

/** Read the re-prompt info from an interrupt payload (`payload.data`). */
export function resumeValidationInfo(payload: unknown): ResumeValidationInfo | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d["validationError"] !== "string") return undefined;
  return {
    validationError: d["validationError"],
    attempt: typeof d["attempt"] === "number" ? d["attempt"] : 0,
    maxAttempts: typeof d["maxAttempts"] === "number" ? d["maxAttempts"] : DEFAULT_MAX_RESUME_ATTEMPTS,
    exhausted: d["exhausted"] === true,
  };
}
