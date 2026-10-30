/**
 * Workshop session contract: the interrupt payload a `workshop` node raises
 * (`interrupt.payload.data`) and the resume value a client sends back.
 *
 * Single source of truth shared by @flowgraph/core (producer) and
 * @flowgraph/workshop-session (client). Types only; no runtime code.
 */

export type WorkshopAgendaItem = {
  id: string;
  title: string;
  description?: string | undefined;
};

export type WorkshopVoiceHints = {
  provider?: string | undefined;
  model?: string | undefined;
  voice?: string | undefined;
};

export type WorkshopLimits = {
  maxMinutes?: number | undefined;
  maxTurns?: number | undefined;
};

/** `with.diff` resolved at interrupt time. */
export type WorkshopDiff =
  | { before: string; after: string }
  | { cwd: string; base?: string | undefined; patch: string; truncated?: boolean | undefined }
  | { cwd: string; error: string };

/** Interrupt payload (`payload.data`) the engine sends to a workshop client. */
export type WorkshopContract = {
  mode: "workshop";
  agenda: WorkshopAgendaItem[];
  fallback: "form" | "text" | "json";
  schema?: Record<string, unknown> | undefined;
  context?: unknown;
  facilitator?: string | undefined;
  voice?: WorkshopVoiceHints | undefined;
  limits?: WorkshopLimits | undefined;
  /** Rendered `with.artifacts` references (paths / URLs). */
  artifactRefs?: string[] | undefined;
  diff?: WorkshopDiff | undefined;
  /** Human-readable diff summary (absent when the diff failed; see `diff.error`). */
  diffStat?: string | undefined;
  /** Set when the previous answer was rejected (re-prompt). */
  validationError?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  exhausted?: boolean | undefined;
};

export type WorkshopTranscriptTurn = {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  at?: string | undefined;
};

/** Resume value a client sends (`{ output, transcript?, coverage?, endedReason? }`). */
export type WorkshopResume = {
  output: Record<string, unknown>;
  transcript: WorkshopTranscriptTurn[];
  coverage: Record<string, boolean | string>;
  endedReason: string;
};
