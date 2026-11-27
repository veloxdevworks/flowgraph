import { z } from "zod";
import { ContractSchemaSchema, FormUiSchema, strictObject, strictWith } from "@flowgraph/spec";

export const WorkshopAgendaItemSchema = z.union([
  z.string(),
  strictObject({
    id: z.string().optional(),
    title: z.string(),
    description: z.string().optional(),
  }),
]);

export const WorkshopVoiceSchema = strictObject({
  /** Voice provider key: xai | openai */
  provider: z.string().optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
});

export const WorkshopLimitsSchema = strictObject({
  maxMinutes: z.number().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const WorkshopWithSchema = strictWith({
  /** Interrupt reason / opening recap shown to the human. */
  message: z.string().optional(),
  /**
   * Re-prompt budget for answers that fail validation (schema / decision / choice).
   * The interrupt is re-issued with `validationError` until this many answers were
   * rejected; then the run fails but the interrupt stays pending. Default 3.
   */
  maxResumeAttempts: z.number().int().positive().optional(),
  /** Agenda items the facilitator must cover. Strings or { id, title, description }. */
  agenda: z.array(WorkshopAgendaItemSchema).optional(),
  /** JSON Schema (draft-07) for the structured output the session must produce. */
  schema: ContractSchemaSchema.optional(),
  /** Form presentation hints for the fallback form; not part of the schema. */
  ui: FormUiSchema.optional(),
  /** Primed research / packet from a prior prepare node (string or object). */
  context: z.union([z.string(), z.record(z.unknown())]).optional(),
  /** System prompt for the facilitator (voice or text). */
  facilitator: z.string().optional(),
  voice: WorkshopVoiceSchema.optional(),
  /** Optional git diff at interrupt time (same shape as hitl). */
  diff: strictObject({
      cwd: z.string().optional(),
      base: z.string().optional(),
      paths: z.array(z.string()).optional(),
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .optional(),
  artifacts: z.array(z.string()).optional(),
  limits: WorkshopLimitsSchema.optional(),
  /** Headless / no-mic fallback: form | text | json. Default form. */
  fallback: z.union([z.literal("form"), z.literal("text"), z.literal("json")]).optional().default("form"),
  /**
   * Accept an unfinished output when the session ends early (`endedReason` of
   * human_ended, timeout or skipped). The node then writes `complete: false`, so
   * later nodes can route on it. Property types are still checked. Default false.
   */
  allowPartial: z.boolean().optional(),
  /**
   * A session that ends `completed` must have covered every agenda item (`coverage[id]`
   * truthy). Early ends (`allowPartial`) are exempt. Default false.
   */
  requireCoverage: z.boolean().optional(),
  /**
   * Keep the transcript in the node result (`keep`, default) or drop it (`omit`) so long
   * sessions do not bloat checkpointed state.
   */
  transcript: z.union([z.literal("keep"), z.literal("omit")]).optional(),
});

export type WorkshopWith = z.infer<typeof WorkshopWithSchema>;
