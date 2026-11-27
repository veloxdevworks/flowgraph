import { z } from "zod";
import { contractSchemaProblem } from "./validate-json-schema.js";
import { channelTypeConflict } from "./channel-contract.js";
import { hookEventFires, hookVerbAllowed, hookVerbMessage } from "./hooks.js";
import { keyedUnion, strictObject, unionBy } from "./strict.js";
import { engineRangeProblem } from "./engine.js";

// ---------------------------------------------------------------------------
// Primitives & shared
// ---------------------------------------------------------------------------

export const VersionSchema = z.literal("flowgraph/v1");
export const KindSchema = z.literal("Graph");

/**
 * Namespaced plugin node type: `<namespace>:<name>`, `<namespace>/<name>`,
 * or `@<scope>/<pkg>:<name>` / `@<scope>/<pkg>/<name>`.
 */
export const PLUGIN_NODE_TYPE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z][a-z0-9-]*[:/][a-z][a-z0-9-]*$/;

export function isNamespacedPluginType(type: string): boolean {
  return PLUGIN_NODE_TYPE_PATTERN.test(type);
}

export const MetadataSchema = strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case")
    .describe("Unique graph name (kebab-case)"),
  description: z.string().optional(),
  version: z.string().optional().describe("Semver of this graph"),
  labels: z.record(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Graph-level triggers (host-interpreted start conditions)
// ---------------------------------------------------------------------------

const triggerBase = {
  /** Stable id within this graph (used by hosts for dedupe / disable). */
  id: z.string().min(1),
  /** When false, hosts ignore the trigger. Default true. */
  enabled: z.boolean().optional(),
};

export const CronTriggerSchema = strictObject({
  ...triggerBase,
  type: z.literal("cron"),
  /** Standard 5-field cron expression (minute hour day-of-month month day-of-week). */
  schedule: z.string().min(1),
  /** IANA timezone (e.g. "America/Denver"). Host default when omitted. */
  timezone: z.string().optional(),
});

export const IntervalTriggerSchema = strictObject({
  ...triggerBase,
  type: z.literal("interval"),
  every: z.number().positive(),
  unit: z.enum(["seconds", "minutes", "hours"]),
});

export const StartupTriggerSchema = strictObject({
  ...triggerBase,
  type: z.literal("startup"),
});

export const FlowCompleteTriggerSchema = strictObject({
  ...triggerBase,
  type: z.literal("flow-complete"),
  /** Target graph `metadata.name` (kebab-case). */
  graph: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "graph must be kebab-case"),
});

export const FlowFailedTriggerSchema = strictObject({
  ...triggerBase,
  type: z.literal("flow-failed"),
  /** Target graph `metadata.name` (kebab-case). */
  graph: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "graph must be kebab-case"),
});

export const WebhookTriggerSchema = strictObject({
  ...triggerBase,
  type: z.literal("webhook"),
  /**
   * URL path segment under the host's trigger ingress (e.g. "/hooks/my-graph").
   * When omitted, hosts typically derive a slug from `metadata.name`.
   */
  path: z.string().optional(),
});

export const FileWatchTriggerSchema = strictObject({
  ...triggerBase,
  type: z.literal("file-watch"),
  /** Absolute or workspace-relative file/directory path to watch. */
  path: z.string().min(1),
  events: z.array(z.enum(["create", "change", "delete"])).optional(),
});

/** Discriminated union of graph-level auto-start triggers (host-interpreted). */
export const TriggerSchema = z.discriminatedUnion("type", [
  CronTriggerSchema,
  IntervalTriggerSchema,
  StartupTriggerSchema,
  FlowCompleteTriggerSchema,
  FlowFailedTriggerSchema,
  WebhookTriggerSchema,
  FileWatchTriggerSchema,
]);

export type Trigger = z.infer<typeof TriggerSchema>;
export type CronTrigger = z.infer<typeof CronTriggerSchema>;
export type IntervalTrigger = z.infer<typeof IntervalTriggerSchema>;
export type StartupTrigger = z.infer<typeof StartupTriggerSchema>;
export type FlowCompleteTrigger = z.infer<typeof FlowCompleteTriggerSchema>;
export type FlowFailedTrigger = z.infer<typeof FlowFailedTriggerSchema>;
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;
export type FileWatchTrigger = z.infer<typeof FileWatchTriggerSchema>;

// JSON Schema primitive type names accepted in data contracts.
export const JsonSchemaTypeSchema = z.union([
  z.literal("string"),
  z.literal("number"),
  z.literal("integer"),
  z.literal("boolean"),
  z.literal("object"),
  z.literal("array"),
  z.literal("null"),
]);

/**
 * A data contract: a JSON Schema (draft-07) checked by Ajv. Used for hitl `form` /
 * `review` schemas, wait webhook payloads, workshop output, agent output, skill inputs /
 * outputs and channel item / property shapes. Unknown keywords and formats are rejected.
 * A `{{ … }}` template in a value that affects validation is checked after rendering;
 * the rest of the schema is checked when the graph is validated.
 */
export const ContractSchemaSchema: z.ZodType<PropertyDef, z.ZodTypeDef, unknown> = z
  .record(z.unknown())
  .superRefine((schema, ctx) => {
    const problem = contractSchemaProblem(schema, { templates: true });
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid JSON Schema: ${problem}` });
  }) as unknown as z.ZodType<PropertyDef, z.ZodTypeDef, unknown>;

/** A JSON Schema used in skill inputs / outputs and channel `items` / `properties`. */
export const PropertySchema = ContractSchemaSchema;

/** A JSON Schema (draft-07) object. Common keywords are typed; any other draft-07 keyword is allowed. */
export type PropertyDef = {
  type?: z.infer<typeof JsonSchemaTypeSchema> | z.infer<typeof JsonSchemaTypeSchema>[] | undefined;
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: PropertyDef | PropertyDef[];
  properties?: Record<string, PropertyDef>;
  required?: string[];
  additionalProperties?: boolean | PropertyDef;
  $ref?: string;
  [keyword: string]: unknown;
};

/**
 * How a form shows one field. Kept apart from the data schema, which only says what a
 * valid answer is.
 */
export const FormFieldHintSchema = strictObject({
  label: z.string().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  widget: z.enum(["text", "textarea", "password", "select", "radio", "checkbox"]).optional(),
});

/** Presentation hints for a form, keyed by top-level schema property; `order` lists fields first-to-last. */
export const FormUiSchema = strictObject({
  order: z.array(z.string()).optional(),
  fields: z.record(FormFieldHintSchema).optional(),
});

// ---------------------------------------------------------------------------
// State / channels
// ---------------------------------------------------------------------------

const reducerErrorMap: z.ZodErrorMap = (_issue, ctx) => ({
  message:
    ctx.data === "concat"
      ? 'reducer "concat" was removed; use "append", which concatenates arrays the same way'
      : "expected one of lastWrite | append | merge | mergeDeep | messages | custom:<name>",
});

export const ReducerSchema = z.union(
  [
    z.literal("lastWrite"),
    z.literal("append"),
    z.literal("merge"),
    z.literal("mergeDeep"),
    z.literal("messages"),
    z.string({ errorMap: reducerErrorMap }).startsWith("custom:"),
  ],
  { errorMap: reducerErrorMap },
);

export const ChannelTypeSchema = z.union([
  z.literal("string"),
  z.literal("number"),
  z.literal("boolean"),
  z.literal("object"),
  z.literal("array"),
  z.literal("messages"),
  z.literal("any"),
]);

// ---------------------------------------------------------------------------
// Retry / timeout
// ---------------------------------------------------------------------------

export const BackoffSchema = z.union([
  z.literal("fixed"),
  z.literal("linear"),
  z.literal("exponential"),
]);

export const RetrySchema = strictObject({
  maxAttempts: z.number().int().positive().optional().default(1),
  backoff: BackoffSchema.optional().default("exponential"),
  baseMs: z.number().positive().optional().default(500),
  maxMs: z.number().positive().optional().default(30000),
  factor: z.number().positive().optional().default(2),
  retryOn: z.array(z.union([z.number(), z.string()])).optional(),
  jitter: z.boolean().optional().default(true),
});

// Duration string: "30s", "5m", "2h"
export const DurationSchema = z.string().regex(/^\d+(\.\d+)?(ms|s|m|h|d)$/, "Invalid duration");

const relocatedFields = new WeakSet<object>();

/**
 * A setting that is not part of the contract. If present, validation fails
 * with `message`, which should name the canonical field to use instead.
 */
function relocatedField(message: string) {
  const field = z
    .any()
    .superRefine((_value, ctx) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    })
    .optional();
  relocatedFields.add(field._def);
  return field;
}

/** True for a field that only exists to reject a relocated setting; the published JSON Schema leaves it out. */
export function isRelocatedFieldDef(def: object): boolean {
  return relocatedFields.has(def);
}

const NODE_INPUT_MOVED =
  "with.input was removed; set the node's own input: instead. Any value is allowed there, templates render at every depth, and the node reads it as {{ input }}";

// ---------------------------------------------------------------------------
// Channel data contracts
// ---------------------------------------------------------------------------

/** A draft-07 schema checked on every write. No `{{ }}` rendering happens here: it is the plain dialect. */
const DataSchemaSchema = z.record(z.unknown()).superRefine((schema, ctx) => {
  const problem = contractSchemaProblem(schema);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid JSON Schema: ${problem}` });
});

export const ChannelSchema = strictObject({
  type: ChannelTypeSchema,
  description: z.string().optional(),
  default: z.unknown().optional(),
  reducer: ReducerSchema.optional(),
  schema: DataSchemaSchema.optional().describe(
    "JSON Schema (draft-07) the channel's value must match after every write. `type` is shorthand for a schema with just that type.",
  ),
  items: relocatedField(
    "channel items was removed; describe the contents with schema, e.g. schema: { type: array, items: { type: string } }",
  ),
  properties: relocatedField(
    "channel properties was removed; describe the contents with schema, e.g. schema: { type: object, properties: { name: { type: string } } }",
  ),
})
  .superRefine((channel, ctx) => {
    if (!channel.schema) return;
    const conflict = channelTypeConflict({ type: channel.type, schema: channel.schema });
    if (conflict) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schema"], message: conflict });
  });

export const StateSchema = strictObject({
  channels: z.record(ChannelSchema),
});
// ---------------------------------------------------------------------------
// Output mapping
// ---------------------------------------------------------------------------

/**
 * How a node's result is written into state.
 *
 * - omitted / `{}` — save the raw result to `state.outputs.<nodeId>`, replacing
 *   that node's previous result (see runtime `applyOutput`)
 * - `"none"` — opt out; write nothing
 * - `{ to }` and/or `{ map }` — projections, written alongside `state.outputs.<nodeId>`
 * - `raw: false` with `to` / `map` — write only the projections
 */
const noneKey = z.unknown().optional();
relocatedFields.add(noneKey._def);

export const OutputMappingObjectSchema = strictObject({
  /** Write the full result to this channel (in addition to `state.outputs.<nodeId>`). */
  to: z.string().optional(),
  /** Project fields from `result` into channels (in addition to `state.outputs.<nodeId>`). */
  map: z.record(z.string({ invalid_type_error: 'Use an expression string, for example "{{ [\'x\'] }}", instead of a YAML list or object.' })).optional(),
  /**
   * Also keep the raw result under `state.outputs.<nodeId>` (default `true`).
   * `false` keeps only the `to` / `map` projections, so large or sensitive
   * results are not stored in state or checkpoints.
   */
  raw: z.boolean().optional(),
  /** Not supported: write `output: none`. Declared only so any `none` key is rejected with a clear message. */
  none: noneKey,
});

const OUTPUT_MAPPING_FORMS =
  'expected "none", { to: "<channel>" }, and/or { map: { <channel>: "<expr>" } }, optionally with raw: false. Map values must be expression strings, for example "{{ [\'x\'] }}", rather than YAML lists or objects.';

/** The message for an output mapping that uses a removed or contradictory form, if any. */
function outputMappingFormError(data: unknown): string | undefined {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(data, "none")) return undefined;
  const m = data as Record<string, unknown>;
  if (m["to"] !== undefined || m["map"] !== undefined) {
    return 'output "none" writes nothing, so it cannot be combined with to or map. Use output: none to write nothing, or keep to / map (with raw: false to skip state.outputs.<nodeId>).';
  }
  return 'the none key is not supported inside an output object; write output: none to write nothing.';
}

const OutputNoneSchema = z.literal("none", { errorMap: () => ({ message: OUTPUT_MAPPING_FORMS }) });

export const OutputMappingSchema = unionBy([OutputNoneSchema, OutputMappingObjectSchema], (data) =>
  typeof data === "string" ? 0 : data !== null && typeof data === "object" && !Array.isArray(data) ? 1 : OUTPUT_MAPPING_FORMS,
)
  .superRefine((value, ctx) => {
    if (typeof value !== "object") return;
    const formError = outputMappingFormError(value);
    if (formError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: formError });
      return;
    }
    if (value.raw === false && value.to === undefined && value.map === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "raw: false needs to or map; to write nothing at all, use output: none.",
        path: ["raw"],
      });
    }
  });

export type OutputMapping = z.infer<typeof OutputMappingSchema>;

// ---------------------------------------------------------------------------
// Node `with` blocks — per-type config
// ---------------------------------------------------------------------------

export const BaseWithSchema = z.object({
  output: OutputMappingSchema.optional(),
});

/** A node's `with` block: `output` plus the node's own fields, with any other key rejected. */
export function strictWith<T extends z.ZodRawShape>(fields: T) {
  return strictObject({ ...BaseWithSchema.shape, ...fields });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const MemoryScopeSchema = z.enum(["org", "project", "graph", "user", "subject"], {
  errorMap: (issue, ctx) =>
    issue.code === "invalid_enum_value"
      ? { message: `must be one of org | project | graph | user | subject (got "${String(issue.received)}")` }
      : { message: ctx.defaultError },
});

// ── agent memory (recall + remember) ──────────────────────────────────────

/** Identifier usable as `{{ memory.<id> }}`. */
const RecallIdSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "recall id must be an identifier ([A-Za-z_][A-Za-z0-9_]*)");

export const SimilarSubjectsSchema = strictObject({
  /** Subject type; defaults to runtime.memory.subject.type and must match it. */
  type: z.string().optional(),
  /** Exact match on item attrs (templates ok). */
  match: z.record(z.unknown()).optional(),
  /** More exact attr filters (e.g. outcome: resolved). */
  where: z.record(z.unknown()).optional(),
  /** Max subjects (default 5, max 50). */
  limit: z.number().int().min(1).max(50).optional(),
  /** Newest items per subject (default 2, max 10). */
  perSubject: z.number().int().min(1).max(10).optional(),
});

export const MemoryRecallBlockSchema = strictObject({
  id: RecallIdSchema,
  /** Scopes to read (default: user > subject > graph > project > org). */
  scopes: z.array(MemoryScopeSchema).min(1).optional(),
  /** Key prefix (templates ok). */
  prefix: z.string().optional(),
  /** Exact attr filters (templates ok). */
  attrs: z.record(z.unknown()).optional(),
  /** Max items from this block before the node budget applies (default 20, max 200). */
  limit: z.number().int().min(1).max(200).optional(),
  /** Collapse the same key across scopes, narrowest wins (default true). */
  dedupe: z.boolean().optional(),
  /** Search other subjects of the same type in this project instead of this run's scopes. */
  similarSubjects: SimilarSubjectsSchema.optional(),
  /** fail (default): a backend error fails the node. skip: record a run issue and continue. */
  onError: z.enum(["fail", "skip"]).optional(),
})
  .superRefine((b, ctx) => {
    if (b.similarSubjects && (b.scopes || b.dedupe !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a similarSubjects block cannot also set scopes or dedupe", path: ["scopes"] });
    }
  });

export const AgentMemoryWritesSchema = strictObject({
  /** Scopes the `remember` tool may write to; the model must name one. */
  scopes: z.array(MemoryScopeSchema).min(1),
  /** Max remember calls per run of this node (default 5, max 50). */
  maxPerRun: z.number().int().min(1).max(50).optional(),
  /** Prefix added to every key the model chooses (default "agent/"). */
  keyPrefix: z.string().min(1).optional(),
  /** Attrs added to every write (templates ok); they override the model's attrs. */
  attrs: z.record(z.unknown()).optional(),
  /** Per-item TTL for non-subject writes, e.g. 90d. */
  ttl: DurationSchema.optional(),
});

export const AgentMemorySchema = strictObject({
  /** Token budget for all recalled memory in this node (estimated bytes/4; default 1000, cap 4000). */
  maxTokens: z.number().int().positive().optional(),
  /** Max recalled items across all blocks (default 20, max 200). */
  maxItems: z.number().int().min(1).max(200).optional(),
  recall: z.array(MemoryRecallBlockSchema).optional(),
  /** Enables the builtin `remember` tool. */
  agentWrites: AgentMemoryWritesSchema.optional(),
});

/**
 * Context management for agent nodes: a token budget for everything sent to the
 * model (system prompt, recalled memory, conversation history, the prompt, tool
 * schemas and the tool loop), and how to shrink history when it does not fit.
 * Shared by `runtime.context` (graph defaults) and an agent's `with.context`.
 */
export const ContextStrategySchema = z.enum(["none", "last", "trim", "summarize"], {
  errorMap: (issue, ctx) =>
    issue.code === "invalid_enum_value"
      ? { message: `must be one of none | last | trim | summarize (got "${String(issue.received)}")` }
      : { message: ctx.defaultError },
});

export const ContextSummarizeSchema = strictObject({
  /** model (default): a model writes the summary; extract: a deterministic list of excerpts, no model call. */
  mode: z.enum(["model", "extract"]).optional(),
  /** Registered provider used to summarize older turns (default: the agent's own provider). */
  provider: z.string().min(1).optional(),
  /** Model for the summarizer, a cheap one is fine (default: the agent's own model when provider is unset). */
  model: z.string().min(1).optional(),
  /** Token cap for the running summary (default 500). */
  maxTokens: z.number().int().positive().optional(),
  /** Extra instructions for the summarizer. */
  instructions: z.string().optional(),
});

const contextPolicyFields = {
  /** Token budget for one model call (default 16000 when a context block is present). */
  maxTokens: z.number().int().positive().optional(),
  /** Tokens held back for the reply (default: with.maxTokens, else 0). */
  reserveTokens: z.number().int().nonnegative().optional(),
  /** How history is shrunk when over budget (default trim). */
  strategy: ContextStrategySchema.optional(),
  /** strategy last: keep at most this many history and tool-loop messages (default 20). */
  lastN: z.number().int().positive().optional(),
  /** Cap on each tool result; longer results are cut with a marker. */
  toolResultMaxTokens: z.number().int().positive().optional(),
  /** strategy summarize: how older turns are folded into a running summary. */
  summarize: ContextSummarizeSchema.optional(),
  /** Cap on the known-issues section of the system prompt; the newest issues are kept (default min(1000, a quarter of the usable budget)). */
  issuesMaxTokens: z.number().int().positive().optional(),
  /** Registered token estimator (default "bytes": UTF-8 bytes / 4). */
  estimator: z.string().min(1).optional(),
  /** When the pinned part alone (system, memory, prompt, latest tool turn) is over budget: error (default) or warn. */
  onOverflow: z.enum(["error", "warn"]).optional(),
};

export const RuntimeContextSchema = strictObject(contextPolicyFields);

export const AgentContextSchema = strictObject({
  ...contextPolicyFields,
  /** A `type: messages` channel holding this agent's conversation across steps, loops and runs. */
  history: z.string().min(1).optional(),
  /** What is appended to history per run: the prompt and final reply (turns, default) or every tool turn too (all). */
  record: z.enum(["turns", "all"]).optional(),
  /** Remove messages that no longer fit (and store the running summary) in the history channel. Default true. */
  compact: z.boolean().optional(),
});

// agent node (formerly "intelligent")
const AgentImageSourceSchema = unionBy(
  [
    z.string().min(1),
    strictObject({
      path: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      detail: z.enum(["auto", "low", "high"]).optional(),
      estimatedTokens: z.number().int().positive().optional(),
    }).superRefine((value, ctx) => {
      if ((value.path !== undefined) === (value.url !== undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An image requires exactly one of path or url" });
      }
    }),
  ],
  (data) => (typeof data === "string" ? 0 : isRecord(data) ? 1 : "An image is a path or URL string, or { path | url }"),
);

export const AgentWithSchema = strictWith({
  streaming: z.boolean().optional(),
  /** Reference to a reusable agent definition (AGENT.md), resolved at run time. */
  agent: z.string().optional(),
  system: z.string().optional(),
  prompt: z.string(),
  images: unionBy([AgentImageSourceSchema, z.array(AgentImageSourceSchema).max(16)], (data) => (Array.isArray(data) ? 1 : 0)).optional()
    .describe("Image paths, URLs, data URLs or Artifact references; templates may resolve to a list."),
  tools: z
    .array(
      keyedUnion(
        "A tool",
        [
          strictObject({ skill: z.string() }),
          strictObject({ node: z.string() }),
          strictObject({ function: z.string() }),
          strictObject({ builtin: z.array(z.string()) }),
          strictObject({ mcp: z.string(), tools: z.array(z.string()).optional() }),
        ],
        ["skill", "node", "function", "builtin", "mcp"],
      ),
    )
    .optional(),
  schema: ContractSchemaSchema.optional(),
  maxSteps: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  permission: z.union([z.literal("auto"), z.literal("ask"), z.literal("deny")]).optional(),
  /** Long-term memory: recall into the prompt within a token budget, and the `remember` tool. */
  memory: AgentMemorySchema.optional(),
  /** Context budget and history management (see AgentContextSchema). */
  context: AgentContextSchema.optional(),
});

// skill node
export const SkillWithSchema = strictWith({});

// router node — routes are an ordered list so YAML order is the match order
export const RouterRouteSchema = strictObject({
  name: z.string().min(1).optional(),
  when: z.string().optional(),
  default: z.boolean().optional(),
  to: z.string().min(1),
  description: z.string().optional(),
});

function guardEntryProblem(
  entry: { when?: string | undefined; default?: boolean | undefined },
): string | undefined {
  const hasWhen = typeof entry.when === "string" && entry.when.trim().length > 0;
  const isDefault = entry.default === true;
  if (hasWhen && isDefault) return "takes when or default, not both";
  if (!hasWhen && !isDefault) return "needs when or default";
  return undefined;
}

function oneDefault(
  entries: Array<{ default?: boolean | undefined }>,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  label: string,
): void {
  const defaults = entries.filter((entry) => entry.default === true);
  if (defaults.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${label} allows one default`,
    });
  }
}

export const RouterWithSchema = strictObject({
  mode: z.union([z.literal("rules"), z.literal("model")]).default("rules"),
  input: z.string().optional(),
  instruction: z.string().optional(),
  routes: z.array(RouterRouteSchema, {
    invalid_type_error: "routes must be a list of - name: entries",
    required_error: "routes must be a list of - name: entries",
  }).min(1),
  match: z.union([z.literal("firstMatch"), z.literal("allMatches")]).optional().default("firstMatch"),
  output: OutputMappingSchema.optional(),
})
  .superRefine((value, ctx) => {
    if (value.mode === "rules") {
      for (const field of ["input", "instruction"] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `router mode: rules does not use ${field}; rules read state through each route's when. Remove it, or use mode: model.`,
          });
        }
      }
    }
    if (value.mode === "model" && value.match === "allMatches") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["match"],
        message:
          "router mode: model cannot use match: allMatches; a model router selects one route. Use mode: rules for allMatches, or omit match.",
      });
    }
    if (value.mode === "model" && !value.input?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input"],
        message:
          "router mode: model requires input: the text the model routes on, e.g. input: \"{{ state.request }}\". The router does not send the whole state.",
      });
    }
    const names = new Set<string>();
    value.routes.forEach((route, index) => {
      if (route.name) {
        if (names.has(route.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["routes", index, "name"],
            message: `Duplicate route name "${route.name}"`,
          });
        }
        names.add(route.name);
      }
      if (value.mode === "model") {
        if (!route.name) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["routes", index, "name"],
            message: "model routes need a name",
          });
        }
        if (route.when?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["routes", index, "when"],
            message: "model routes do not take when; the model chooses by name",
          });
        }
      } else {
        const problem = guardEntryProblem(route);
        if (problem) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["routes", index],
            message: `A route ${problem}`,
          });
        }
      }
    });
    oneDefault(value.routes, ctx, ["routes"], "A route list");
  });

// http node
export const HttpWithSchema = strictWith({
  method: z
    .union([
      z.literal("GET"),
      z.literal("POST"),
      z.literal("PUT"),
      z.literal("PATCH"),
      z.literal("DELETE"),
      z.literal("HEAD"),
    ])
    .default("GET"),
  url: z.string(),
  headers: z.record(z.string()).optional(),
  query: z.record(z.unknown()).optional(),
  body: z.unknown().optional(),
  expect: strictObject({ status: z.array(z.number()).min(1, "expect.status needs at least one status code") }).optional(),
  once: z
    .boolean()
    .optional()
    .describe("Send at most once per run (idempotent across checkpoint replays)"),
}).superRefine((value, ctx) => {
  if ((value.method === "GET" || value.method === "HEAD") && value.body !== undefined && value.body !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body"],
      message: `http ${value.method} requests carry no body; remove body, or set method to POST, PUT, PATCH or DELETE`,
    });
  }
});

export const ToolRequireSchema = strictObject({
  bin: z.string().min(1).describe("Binary that must be on PATH"),
  version: z.string().optional().describe("Human-readable constraint, e.g. \">=1.22\""),
});

export const OnMissingToolSchema = z
  .union([z.literal("fail"), z.literal("skip")])
  .optional()
  .default("fail")
  .describe("fail (default) throws; skip records a TOOL_NOT_FOUND issue and continues");

// function node (formerly "code") — legacy programmatic escape hatch
export const FunctionWithSchema = strictWith({
  fn: z.string().describe("Registered function name"),
  input: relocatedField(NODE_INPUT_MOVED),
});

// memory node — read/write scoped durable memory (requires runtime.memory)
export const MemoryOpSchema = z.enum(["get", "search", "put", "patch", "increment", "append", "delete"]);

/** The `with` fields each memory op reads, besides `op` and `output`. */
const MEMORY_OP_FIELDS: Record<z.infer<typeof MemoryOpSchema>, readonly string[]> = {
  get: ["key", "scope", "scopes", "required"],
  search: ["prefix", "attrs", "limit", "scope", "scopes"],
  put: ["key", "value", "scope", "attrs", "ttl", "ifVersion"],
  patch: ["key", "value", "scope", "attrs", "ttl", "ifVersion"],
  increment: ["key", "field", "by", "scope", "attrs", "ttl", "ifVersion"],
  append: ["key", "value", "max", "scope", "attrs", "ttl", "ifVersion"],
  delete: ["key", "scope", "ifVersion"],
};

export const MemoryWithSchema = strictWith({
  op: MemoryOpSchema,
  /**
   * Target scope for writes. Omitted: user (or graph when the run has no user),
   * with a MEMORY_SCOPE_IMPLICIT lint warning. Required for subject/project/org.
   */
  scope: MemoryScopeSchema.optional(),
  /** Read scopes for get/search, in order. Default: user, subject, graph, project, org. */
  scopes: z.array(MemoryScopeSchema).min(1).optional(),
  key: z.string().optional(),
  /** search: key prefix. */
  prefix: z.string().optional(),
  /** put/patch: the value; append: the item. Templates are rendered. */
  value: z.unknown().optional(),
  attrs: z.record(z.unknown()).optional(),
  /** increment: object field to bump (default "count"; "" bumps a bare number). */
  field: z.string().optional(),
  by: z.union([z.number(), z.string()]).optional(),
  /** append: max list length (default 100, cap 1000). */
  max: z.number().int().positive().optional(),
  /** CAS: expected version; 0 = create only. */
  ifVersion: z.union([z.number().int().nonnegative(), z.string()]).optional(),
  ttl: DurationSchema.optional(),
  /** search: max results (default 20, max 200). */
  limit: z.number().int().positive().max(200).optional(),
  /** get: fail the node when the key is absent. */
  required: z.boolean().optional(),
}).superRefine((v, ctx) => {
  const allowed = MEMORY_OP_FIELDS[v.op];
  for (const field of Object.keys(v)) {
    if (field === "op" || field === "output" || allowed.includes(field)) continue;
    if ((v as Record<string, unknown>)[field] === undefined) continue;
    ctx.addIssue({
      code: "custom",
      path: [field],
      message: `op "${v.op}" does not use ${field}; it takes ${allowed.join(", ")}`,
    });
  }
  if (v.op !== "search" && !v.key) ctx.addIssue({ code: "custom", path: ["key"], message: `op "${v.op}" requires key` });
  if ((v.op === "put" || v.op === "patch" || v.op === "append") && v.value === undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: `op "${v.op}" requires value` });
  }
  if ((v.op === "get" || v.op === "search") && v.scope !== undefined && v.scopes !== undefined) {
    ctx.addIssue({ code: "custom", path: ["scope"], message: "use either scope or scopes, not both" });
  }
});

// shell node — run a program with argv (no shell), or a fixed command line through the OS shell with `shell: true`
export const ShellWithSchema = strictWith({
  command: z
    .string()
    .describe("Program to run. With shell: true, a fixed shell command line. Never a template: pass run data in args, or in env with shell: true"),
  args: z.array(z.string()).optional().describe("Arguments, passed to the program without a shell; templates are rendered per argument"),
  shell: z
    .boolean()
    .optional()
    .describe("Run command through the OS shell (pipes, &&, globs). Pass run data in env and quote it in the command (\"$NAME\")"),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  inheritEnv: z.array(z.string().min(1)).optional().describe("Host environment variable names to pass to the child, in addition to the default allowlist (PATH, HOME, TMPDIR, TEMP, TMP, LANG, LC_ALL, and Windows SystemRoot/WINDIR)"),
  input: relocatedField(NODE_INPUT_MOVED),
  expect: strictObject({ exitCode: z.array(z.number()).min(1, "expect.exitCode needs at least one exit code").optional() }).optional(),
  requires: z.array(ToolRequireSchema).optional(),
  onMissingTool: OnMissingToolSchema,
}).superRefine((v, ctx) => {
  if (v.command.includes("{{")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: v.shell
        ? "command cannot contain {{ }} templates, because rendered values would become shell syntax; pass them in env and quote them in the command (\"$NAME\")"
        : "command cannot contain {{ }} templates; pass run data in args",
    });
  }
  if (v.shell && v.args !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["args"],
      message: "args cannot be combined with shell: true; pass values in env and quote them in the command (\"$NAME\")",
    });
  }
  if (!v.shell && v.args === undefined && /\s/.test(v.command)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "command runs without a shell, so it names one program: put its arguments in args, or set shell: true to run a shell command line (use args: [] for a program path that contains spaces)",
    });
  }
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export const ArtifactRoleSchema = z.enum(["image", "video", "model3d", "audio", "document", "file"]);

/**
 * A file produced or consumed by a node. State holds this record, never the
 * bytes: the file lives on disk under the run workspace.
 */
export const ArtifactSchema = z.object({
  kind: z.literal("artifact"),
  /** Workspace-relative path (posix separators). */
  path: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  role: ArtifactRoleSchema.optional(),
  sha256: z.string().optional(),
  meta: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      durationMs: z.number().optional(),
      /** Workspace-relative path of a preview image. */
      thumbnail: z.string().optional(),
      source: z
        .object({
          provider: z.string(),
          vendor: z.string().optional(),
          model: z.string().optional(),
          jobId: z.string().optional(),
          prompt: z.string().optional(),
        })
        .optional(),
      costUSD: z.number().nonnegative().optional(),
    })
    .passthrough()
    .optional(),
});

export const FailWithSchema = strictObject({
  reason: z.string().regex(/\S/, "A failure reason is required")
    .describe("Failure reason; templates render against the node's state and input."),
});

// script node — sandboxed Node.js (ESM) source
export const ScriptPermissionsSchema = strictObject({
  fsRead: z.array(z.string()).optional().describe("Paths granted via --allow-fs-read"),
  fsWrite: z.array(z.string()).optional().describe("Paths granted via --allow-fs-write"),
  childProcess: z.boolean().optional().describe("When true, grants --allow-child-process"),
  workerThreads: z.boolean().optional().describe("When true, grants --allow-worker"),
});

export const ScriptWithSchema = strictWith({
  code: z
    .string()
    .regex(/\S/, "Script code must not be empty")
    .optional()
    .describe("Self-contained Node.js ESM source with a default-export function; mutually exclusive with file."),
  file: z.string().trim().min(1).optional().describe("Self-contained ESM source file, relative to the declaring graph; mutually exclusive with code."),
  input: relocatedField(NODE_INPUT_MOVED),
  env: z.record(z.string()).optional().describe("Environment variables available to the child process"),
  permissions: ScriptPermissionsSchema.optional(),
  requires: z.array(ToolRequireSchema).optional(),
  onMissingTool: OnMissingToolSchema,
}).superRefine((value, ctx) => {
  if ((value.code !== undefined) === (value.file !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "script: provide exactly one of code or file" });
  }
});

// subgraph node
export const SubgraphWithSchema = strictWith({
  stateMap: strictObject({
    /** Child channel ← parent channel name or `{{ }}` expression. */
    in: z
      .record(z.string())
      .optional()
      .describe("Child channel ← parent channel or {{ }} expression"),
    /**
     * Parent channel ← child channel name or `{{ }}` expression.
     * Keys are parent channels (where the value is written). Values read the child.
     * Omit to merge channels that share a name; the parent's reducer applies.
     */
    out: z
      .record(z.string())
      .optional()
      .describe("Parent channel ← child channel or {{ }} expression"),
  })
    .refine((map) => map.in !== undefined || map.out !== undefined, {
      message: "stateMap needs in or out; remove it to merge channels that share a name",
    })
    .optional()
    .describe("Explicit projection between parent and child channels"),
}).superRefine((value, ctx) => {
  if (value.stateMap?.out !== undefined && value.output !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["output"],
      message:
        "subgraph: set stateMap.out or output, not both. stateMap.out names each parent channel to write; output projects the whole child result (to / map, or none)",
    });
  }
});

/** Names a template already binds, so a map item cannot take them. */
const MAP_RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  "index", "state", "input", "config", "run", "secret", "secrets", "issues", "memory", "result",
]);

// map node
export const MapWithSchema = strictObject({
  memoize: unionBy([z.boolean(), strictObject({
    key: z.string().optional(), version: z.string().optional(),
    maxEntries: z.number().int().positive().max(10000).optional(),
    maxBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
  })], (data) => (typeof data === "boolean" ? 0 : isRecord(data) ? 1 : "memoize is true, false or { key, version, maxEntries, maxBytes }")).optional().describe("Reuse completed item results across loop rounds; opt in only for deterministic item work"),
  over: z.string().describe("Expression evaluating to an array"),
  as: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "as must be an identifier, such as item or task")
    .refine((name) => !MAP_RESERVED_BINDINGS.has(name), {
      message: `as cannot be ${[...MAP_RESERVED_BINDINGS].join(", ")}: those names are already bound in templates (index is the item's position)`,
    })
    .default("item")
    .describe("Name the current item is bound to in the node body: {{ <as> }}. {{ index }} is its position."),
  concurrency: z.number().int().positive().optional().default(5),
  node: z
    .lazy((): typeof MapBodyNodeSchema => MapBodyNodeSchema)
    .describe("The node run once per item: a node spec whose id is optional"),
  collect: OutputMappingSchema.optional(),
  output: relocatedField(
    "map with.output is not supported: write the collected results with with.collect (to / map), or set output on the node body (with.node.with.output) to project each item",
  ),
});

/** A hitl route target: a node id, or `{ to, description }`. */
export const HitlRouteSchema = unionBy(
  [z.string(), strictObject({ to: z.string(), description: z.string().optional() })],
  (data) => (typeof data === "string" ? 0 : isRecord(data) ? 1 : "A route is a node id, or { to, description }"),
);

// hitl node — human-in-the-loop gate (approve, question, choice, form, review)
export const HitlWithSchema = strictWith({
  mode: z
    .union([
      z.literal("approve"),
      z.literal("question"),
      z.literal("choice"),
      z.literal("form"),
      z.literal("review"),
    ])
    .default("approve"),
  message: z.string(),
  choices: z.array(z.string()).optional(),
  /** JSON Schema (draft-07) for the answer to `mode: form`, and optionally to `mode: review`. */
  schema: ContractSchemaSchema.optional(),
  /** Form presentation hints (labels, placeholders, widgets, field order); not part of the schema. */
  ui: FormUiSchema.optional(),
  /** `mode: review` — compute a git diff at interrupt time, or pass inline before/after. */
  diff: strictObject({
    cwd: z.string().optional(),
    base: z.string().optional(),
    paths: z.array(z.string()).optional(),
    before: z.string().optional(),
    after: z.string().optional(),
  }).optional(),
  /**
   * `approve` / `choice` / `review` — files shown to the human. Each entry is a template that
   * may render to an Artifact, an array of Artifacts, a media node's whole output
   * (`{ artifact, artifacts }`), a workspace-relative path, demo-manifest ref, or an array of those.
   */
  artifacts: z.array(z.string()).optional(),
  /**
   * Let the human pick from `artifacts`: `one` or `many` (default `none`). The answer carries
   * `selected` (a path, `{ path }`, or an array); only presented artifacts are accepted, and the
   * node outputs the matching Artifact record(s) as `selected`.
   */
  select: z.enum(["none", "one", "many"]).optional(),
  /** `mode: review` — extra decision labels beyond approve / request-changes. */
  decision: z.array(z.string()).optional(),
  /**
   * Route on the human's answer instead of following the node's outgoing edges. Keys are
   * the outcomes — `approved` / `rejected` for `approve`, each entry of `choices` for
   * `choice`, each decision for `review` — and each value is the node to go to next.
   * `default` catches any outcome without its own route (needed when `choices` are
   * templated). Not available for `question` / `form`. The answer is still written to
   * `output`, so later nodes can read it.
   */
  routes: z.record(HitlRouteSchema).optional(),
  /**
   * Re-prompt budget for answers that fail validation (schema / decision / choice).
   * The interrupt is re-issued with `validationError` until this many answers were
   * rejected; then the run fails but the interrupt stays pending. Default 3.
   */
  maxResumeAttempts: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  const mode = value.mode;
  const set = (field: keyof typeof value): boolean => value[field] !== undefined;
  const refuse = (field: string, modes: string) =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `hitl mode: ${mode} does not use ${field}; it applies to mode: ${modes}`,
    });
  if (mode === "choice" && !(value.choices && value.choices.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["choices"], message: "hitl mode: choice needs choices: a non-empty list of answers" });
  }
  if (mode === "approve" && set("choices") && set("schema")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schema"],
      message: "hitl mode: approve takes choices or schema, not both; use mode: choice for a closed list of answers, or mode: form for a structured answer",
    });
  }
  if (set("choices") && mode !== "approve" && mode !== "choice") refuse("choices", "choice (or approve)");
  if (set("schema") && mode !== "form" && mode !== "review" && !(mode === "approve" && !set("choices"))) refuse("schema", "form or review");
  if (set("ui") && mode !== "form" && mode !== "review") refuse("ui", "form or review");
  if (set("diff") && mode !== "review") refuse("diff", "review");
  if (set("decision") && mode !== "review") refuse("decision", "review");
  if (set("routes") && (mode === "question" || mode === "form")) refuse("routes", "approve, choice or review");
  for (const field of ["artifacts", "select"] as const) {
    if (set(field) && (mode === "question" || mode === "form")) refuse(field, "approve, choice or review");
  }
});

// wait node — deadline / until / signal / webhook (inbound HTTP resume)
export const WaitWithSchema = strictWith({
  deadline: DurationSchema.optional().describe("In-process sleep. Not durable across a restart."),
  until: z.string().regex(/\S/, "until needs a condition").optional(),
  signal: z.string().regex(/\S/, "signal needs a name").optional().describe("Resume only when the payload names this signal"),
  timeout: DurationSchema.optional(),
  /** When set, interrupt and listen for an inbound HTTP POST to resume. */
  webhook: unionBy(
    [z.literal(true), strictObject({ schema: ContractSchemaSchema.optional() })],
    (data) => (data === true ? 0 : isRecord(data) ? 1 : "webhook is true, or { schema }"),
  ).optional(),
}).superRefine((value, ctx) => {
  const modes = (["deadline", "until", "signal", "webhook"] as const).filter((mode) => value[mode] !== undefined);
  if (modes.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "wait needs one of deadline, until, signal or webhook",
    });
    return;
  }
  if (modes.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `wait takes one of deadline, until, signal or webhook, not several (found ${modes.join(", ")})`,
    });
    return;
  }
  if (value.deadline !== undefined && value.timeout !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["timeout"],
      message: "a deadline wait is itself the delay, so timeout does not apply; use timeout with until, signal or webhook",
    });
  }
});

// mcp node — deterministic MCP tool/resource call
export const McpWithSchema = strictWith({
  server: z.string().describe("MCP server name from mcpServers"),
  tool: z.string().min(1).optional().describe("Tool name to call"),
  resource: z.string().min(1).optional().describe("Resource URI to read"),
  arguments: z.record(z.unknown()).optional().describe("Tool arguments (supports {{ }} templates)"),
}).superRefine((value, ctx) => {
  if ((value.tool !== undefined) === (value.resource !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.tool !== undefined ? "resource" : "tool"],
      message: value.tool !== undefined
        ? "mcp takes tool or resource, not both"
        : "mcp needs tool (call a tool) or resource (read a resource)",
    });
  } else if (value.resource !== undefined && value.arguments !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["arguments"], message: "arguments belong to a tool call; a resource read takes none" });
  }
});

// MCP server connection (top-level mcpServers block)
export const McpAuthSchema = strictObject({
  type: z
    .union([z.literal("none"), z.literal("header"), z.literal("oauth2")])
    .optional()
    .default("none"),
  /** OAuth 2.1 redirect URI (default: http://127.0.0.1:{callbackPort}/callback). */
  redirectUri: z.string().optional(),
  /** Display name for dynamic client registration. */
  clientName: z.string().optional(),
  /** OAuth scopes to request. */
  scope: z.string().optional(),
  /** Local port for the OAuth callback server (default 9876). */
  callbackPort: z.number().int().positive().optional(),
  /** Pre-registered client id; omit to use dynamic client registration. */
  clientId: z.string().optional(),
  /** Pre-registered client secret (supports {{ secret.X }} interpolation). */
  clientSecret: z.string().optional(),
  /** SEP-991 client metadata document URL. */
  clientMetadataUrl: z.string().optional(),
  /** Override token store key (default: mcpServers entry name). */
  tokenStoreKey: z.string().optional(),
});

export const McpServerSchema = z.discriminatedUnion("transport", [
  strictObject({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    auth: McpAuthSchema.optional(),
  }),
  strictObject({
    transport: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string()).optional(),
    auth: McpAuthSchema.optional(),
  }),
]);

// ---------------------------------------------------------------------------
// Placement (`runsOn`) — see docs/adr/0020-node-placement.md
// ---------------------------------------------------------------------------

/** `namespace:value`, e.g. `os:windows`, `app:cc5`, `plugin:@acme/cc5-nodes`, `flowgraph:0.42`. */
export const PLACEMENT_LABEL_PATTERN = /^[a-z][a-zA-Z0-9-]*:[A-Za-z0-9@][A-Za-z0-9._@\/+-]*$/;

export const PlacementLabelSchema = z
  .string()
  .regex(
    PLACEMENT_LABEL_PATTERN,
    "Invalid placement label: use namespace:value, e.g. os:windows or app:cc5",
  );

export const RunsOnObjectSchema = strictObject({
  labels: z.array(PlacementLabelSchema).min(1).describe("All of these labels must match"),
  target: z.string().min(1).optional().describe("Pin to one named target from the topology"),
  fallback: z
    .enum(["error", "local"])
    .optional()
    .describe("`local` runs the node here when no worker matches (default: error)"),
});

export const RunsOnSchema = unionBy(
  [z.array(PlacementLabelSchema).min(1), RunsOnObjectSchema],
  (data) => (Array.isArray(data) ? 0 : isRecord(data) ? 1 : "runsOn is a list of labels, or { labels, target, fallback }"),
);

/** `runsOn` as written: a label list, or the object form. */
export type RunsOn = z.input<typeof RunsOnSchema>;

export interface NormalizedRunsOn {
  labels: string[];
  target?: string;
  fallback: "error" | "local";
  wait?: string;
}

/** Canonical form of `runsOn`: object shape, labels deduped in order, `fallback` defaulted. */
export function normalizeRunsOn(value: RunsOn): NormalizedRunsOn {
  if (Array.isArray(value)) return { labels: [...new Set(value)], fallback: "error" };
  const wait = (value as { wait?: unknown }).wait;
  return {
    labels: [...new Set(value.labels)],
    ...(value.target !== undefined ? { target: value.target } : {}),
    fallback: value.fallback ?? "error",
    ...(typeof wait === "string" ? { wait } : {}),
  };
}

// ---------------------------------------------------------------------------
// Node spec (generic — `with` is typed per-type after resolution)
// ---------------------------------------------------------------------------

export const NodeSpecSchema = strictObject({
  id: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "node id must start with a letter")
    .describe("Unique node id"),
  type: z.string().describe("Node type, resolved via the Node Registry"),
  name: z.string().optional(),
  description: z
    .string()
    .optional()
    .describe(
      "Human-readable description; when this node is exposed as an agent tool, becomes the tool description",
    ),
  notes: z
    .string()
    .optional()
    .describe("Freeform markdown documentation for authors; ignored by the engine"),
  /**
   * JSON Schema for arguments when this node is exposed as an agent tool
   * (`tools: [{ node: "<id>" }]`). Passed to the LLM as the tool's parameter schema.
   * Values land on the invoked node as `ctx._input` / `{{ input.* }}`.
   */
  toolInput: DataSchemaSchema.superRefine((schema, ctx) => {
    const type = schema["type"];
    if (type !== undefined && type !== "object") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"], message: "toolInput describes the arguments object, so its type must be object" });
    }
  }).optional().describe(
    "JSON Schema (draft-07) for agent tool-call arguments when this node is used as a tool. The call's arguments are checked against it before the node runs.",
  ),
  // top-level fields for common types
  provider: z.string().optional(),
  model: z.string().optional(),
  uses: z
    .string()
    .optional()
    .describe("Skill/subgraph reference (path or alias)"),
  /**
   * Inline embedded subgraph GraphSpec (bundling / remote-portability output).
   * Mutually exclusive with `uses` for `type: subgraph` nodes.
   * Lazy to break the GraphSpec ↔ NodeSpec cycle.
   */
  spec: z
    .lazy((): z.ZodTypeAny => GraphSpecSchema)
    .optional()
    .describe(
      "Inline embedded subgraph spec (bundling output); mutually exclusive with `uses`",
    ),
  input: z
    .unknown()
    .optional()
    .describe(
      "The node's input: any value. {{ }} templates render at every depth and the node reads the result as {{ input }}. A skill or subgraph needs an object, whose keys are its inputs.",
    ),
  /**
   * Per-node workspace override (absolute or graph-relative; templates ok).
   * Defaults to `runtime.workspace` then the graph directory.
   */
  workspace: z.string().optional(),
  with: z.record(z.unknown()).optional(),
  retry: RetrySchema.optional(),
  timeout: DurationSchema.optional(),
  runsOn: RunsOnSchema.optional().describe(
    "Run this node on a machine that has all these labels (ADR-0020). Not allowed on hitl, workshop or wait.",
  ),
  when: z.string().optional().describe("Guard expression — skip node if false"),
  on: strictObject({
    error: z
      .union([
        z.literal("fail"),
        z.literal("continue"),
        z.string({
          errorMap: (_issue, ctx) => {
            if (ctx.data === "ignore") {
              return { message: "on.error ignore was removed; use continue" };
            }
            return { message: "on.error must be fail | continue | route:<node>" };
          },
        }).startsWith("route:"),
      ])
      .optional(),
  }).optional(),
});

/**
 * A `map` body (`with.node`): the same fields as a graph node, but `id` is
 * optional because each item runs as `<mapId>[<index>]`. Its `with` is checked
 * against the body type's own schema by validation, as for any node.
 */
export const MapBodyNodeSchema = NodeSpecSchema.extend({
  id: NodeSpecSchema.shape.id.optional(),
});

// NodeSpec is declared after GraphSpec (see below) so `spec?: GraphSpec` can
// close the recursive type without a forward reference.

// ---------------------------------------------------------------------------
// Edge spec
// ---------------------------------------------------------------------------

export const BranchSchema = strictObject({
  when: z.string().optional(),
  default: z.boolean().optional(),
  to: z.string().min(1),
  description: z.string().optional(),
});

const edgeFromSchema = z.union([
  z.string(),
  z.array(z.string()).min(2, "from must list at least two node ids"),
]).describe(
  "Source node id, or a list of node ids. A list is a barrier: to runs once, after every listed source finishes.",
);

export const EdgeSpecSchema = keyedUnion(
  "An edge",
  [
    // static edge. `from` as a list compiles to one multi-source barrier.
    strictObject({
      from: edgeFromSchema,
      to: z.union([z.string(), z.array(z.string())]),
    }).superRefine((edge, ctx) => {
      if (!Array.isArray(edge.from)) return;
      const seen = new Set<string>();
      edge.from.forEach((id, index) => {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate node id "${id}" in from`,
            path: ["from", index],
          });
          return;
        }
        seen.add(id);
      });
    }),
    // conditional edge — each entry is when or default, and fan-out uses to: [...]
    strictObject({
      from: z.string(),
      branch: z.array(BranchSchema).min(1),
    }).superRefine((edge, ctx) => {
      edge.branch.forEach((entry, index) => {
        const problem = guardEntryProblem(entry);
        if (problem) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["branch", index],
            message: `A branch entry ${problem}`,
          });
        }
      });
      oneDefault(edge.branch, ctx, ["branch"], "A branch list");
    }),
  ],
  ["to", "branch"],
);

export type EdgeSpec = z.infer<typeof EdgeSpecSchema>;

// ---------------------------------------------------------------------------
// Import spec
// ---------------------------------------------------------------------------

export const ImportSpecSchema = keyedUnion(
  "An import",
  [
    strictObject({ skill: z.string(), as: z.string().optional() }),
    strictObject({ agent: z.string(), as: z.string().optional() }),
    strictObject({ subgraph: z.string(), as: z.string().optional() }),
    strictObject({ nodes: z.string() }),
    strictObject({ providers: z.string() }),
    strictObject({ reducers: z.string() }),
  ],
  ["skill", "agent", "subgraph", "nodes", "providers", "reducers"],
);

// ---------------------------------------------------------------------------
// Config block
// ---------------------------------------------------------------------------

export const ConfigSchema = strictObject({
  defaults: strictObject({
    provider: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
  vars: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Providers block (LLM backends for agent and model-router nodes)
// ---------------------------------------------------------------------------

export const LangChainVendorSchema = z.enum([
  "openai",
  "anthropic",
  "xai",
  "ollama",
  "google",
  "bedrock",
]);

export const LangChainProviderConfigSchema = strictObject({
  kind: z.literal("langchain"),
  vendor: LangChainVendorSchema,
  model: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  region: z.string().optional(),
});

export const ClaudePermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]);

export const ClaudeProviderConfigSchema = strictObject({
  kind: z.literal("claude"),
  model: z.string().optional(),
  permissionMode: ClaudePermissionModeSchema.optional(),
  cwd: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export const CursorRuntimeSchema = z.enum(["local", "cloud"]);

export const CursorProviderConfigSchema = strictObject({
  kind: z.literal("cursor"),
  model: z.string().optional(),
  runtime: CursorRuntimeSchema.optional(),
  apiKeyEnv: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export const CliVendorSchema = z.enum(["claude", "cursor", "codex", "grok"]);

/** Local agent CLI (Claude Code, Cursor CLI, Codex, Grok Build) — no API key required. */
export const CliProviderConfigSchema = strictObject({
  kind: z.literal("cli"),
  vendor: CliVendorSchema,
  model: z.string().optional(),
  cwd: z.string().optional(),
  /** Override binary name/path (defaults: claude, cursor-agent, codex, grok). */
  binary: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export const DeepAgentsProviderConfigSchema = strictObject({
  kind: z.literal("deepagents"),
  /** Inherit ChatModel from this providers.* entry (default: graph defaults.provider). */
  modelProvider: z.string().optional(),
  model: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

/**
 * Third-party or custom provider plugin loaded via `imports[].providers` or registered
 * in the host. `options` are validated by the plugin adapter at compile time.
 */
export const PluginProviderConfigSchema = strictObject({
  kind: z.literal("plugin"),
  /** Registered provider plugin name; defaults to the key under `providers:`. */
  plugin: z.string().min(1).optional(),
  model: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export const CoreProviderConfigSchema = z.discriminatedUnion("kind", [
  LangChainProviderConfigSchema,
  ClaudeProviderConfigSchema,
  CursorProviderConfigSchema,
  CliProviderConfigSchema,
  DeepAgentsProviderConfigSchema,
  PluginProviderConfigSchema,
]);

const extensionProviderKindSchemas = new Map<string, z.ZodTypeAny>();

/** Register a provider config schema for a non-core provider kind (e.g. `kind: media`). */
export function registerProviderKindSchema(kind: string, schema: z.ZodTypeAny): void {
  extensionProviderKindSchemas.set(kind, schema);
}

/** Config schemas registered for non-core provider kinds, by kind. */
export function registeredProviderKindSchemas(): ReadonlyMap<string, z.ZodTypeAny> {
  return extensionProviderKindSchemas;
}

/** Unregister a provider config schema (primarily for tests). */
export function unregisterProviderKindSchema(kind: string): void {
  extensionProviderKindSchemas.delete(kind);
}

export const ProviderConfigSchema: z.ZodType<ProviderConfig, z.ZodTypeDef, unknown> = z
  .unknown()
  .superRefine((val, ctx) => {
    if (val != null && typeof val === "object" && !Array.isArray(val)) {
      const kind = (val as { kind?: unknown }).kind;
      if (typeof kind === "string") {
        const ext = extensionProviderKindSchemas.get(kind);
        if (ext) {
          const parsed = ext.safeParse(val);
          if (!parsed.success) {
            for (const issue of parsed.error.issues) ctx.addIssue(issue);
          }
          return;
        }
      }
    }
    const parsed = CoreProviderConfigSchema.safeParse(val);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue);
    }
  }) as unknown as z.ZodType<ProviderConfig, z.ZodTypeDef, unknown>;

export const ProvidersSchema = z.record(ProviderConfigSchema);

// ---------------------------------------------------------------------------
// Runtime block
// ---------------------------------------------------------------------------

/**
 * Checkpoint backends. `memory` is process-local; `sqlite` / `postgres` need the host
 * (CLI, server, or a programmatic caller) to inject a saver instance.
 */
export const CheckpointBackendSchema = z.enum(["memory", "sqlite", "postgres"], {
  errorMap: (issue, ctx) =>
    issue.code === "invalid_enum_value"
      ? { message: `must be one of memory | sqlite | postgres (got "${String(issue.received)}")` }
      : { message: ctx.defaultError },
});

export const HitlPolicySchema = z.union([
  z.literal("prompt"),
  z.literal("fail"),
  z.literal("approve"),
  z.literal("webhook"),
]);

/**
 * `runtime.memory` — scoped durable memory (org/project/graph/user/subject).
 * `checkpoint` stores memory in the checkpointer's database and needs a durable
 * checkpointer (sqlite today). `memory` is process-local, for tests.
 */
export const MemoryBackendSchema = z.enum(["checkpoint", "memory"], {
  errorMap: (issue, ctx) =>
    issue.code === "invalid_enum_value"
      ? { message: `must be one of checkpoint | memory (got "${String(issue.received)}")` }
      : { message: ctx.defaultError },
});

export const RuntimeMemorySchema = strictObject({
  backend: MemoryBackendSchema.optional().default("checkpoint"),
  subject: strictObject({
    /** Subject type, e.g. incident, build, ticket. */
    type: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, "must match ^[a-z][a-z0-9_-]{0,63}$"),
    /** Template rendered at run start from input/run only. */
    key: z.string().min(1),
    required: z.boolean().optional().default(false),
    /** Sliding TTL, refreshed on every write to the subject. */
    ttl: DurationSchema.optional().default("180d"),
    /** Store sha256 of the rendered key instead of the key. */
    hash: z.boolean().optional().default(false),
  }).optional(),
  limits: strictObject({
    itemBytes: z.number().int().positive().optional(),
    itemsPerScope: z.number().int().positive().optional(),
    bytesPerScope: z.number().int().positive().optional(),
    subjectsPerType: z.number().int().positive().optional(),
    onFull: z.enum(["evict-oldest", "reject"]).optional(),
  }).optional(),
});

export const CheckpointRetentionSchema = unionBy(
  [
    z.boolean(),
    strictObject({
      /** Default true. `false` keeps every checkpoint and finished thread. */
      enabled: z.boolean().optional(),
      /** Newest checkpoints kept per thread namespace. Default 40. Minimum 1. */
      maxCheckpoints: z.number().int().positive().optional(),
      /**
       * Interrupt and resume checkpoints kept outside that window, newest first.
       * Default 8. The newest checkpoint is always kept.
       */
      maxInterruptPoints: z.number().int().nonnegative().optional(),
      /**
       * Opt-in. Delete completed threads older than this (`14d`, `12h`).
       * `null` (the default) keeps them. Errored, aborted, and paused threads
       * are never deleted.
       */
      finishedTtl: z.union([DurationSchema, z.null()]).optional(),
      /**
       * Opt-in. How many completed threads to keep. `null` (the default) does
       * not cap them. `0` deletes a completed thread when the run finishes.
       */
      maxFinishedThreads: z.number().int().nonnegative().nullable().optional(),
      /**
       * When thread deletion is on, an active thread with no checkpoint or
       * run start for this long (`7d`, `12h`) is treated as abandoned and
       * then follows `finishedTtl` and `maxFinishedThreads`. Default `7d`.
       * `null` keeps such threads until a later run or `deleteThread`.
       */
      activeTtl: z.union([DurationSchema.refine((d) => !/^0+(\.0+)?(ms|s|m|h|d)$/.test(d), "activeTtl must be positive"), z.null()]).optional(),
      /** Store each channel version once. Default true. */
      dedupeChannels: z.boolean().optional(),
      /** `auto` VACUUMs sqlite when free pages exceed live data. Default auto. */
      vacuum: z.enum(["auto", "always", "never"]).optional(),
    }),
  ],
  (data) => (typeof data === "boolean" ? 0 : isRecord(data) ? 1 : "retention is true, false, or an object of retention limits"),
);

export const RuntimeSchema = strictObject({
  checkpoint: strictObject({
    enabled: z.boolean().optional().default(true),
    backend: CheckpointBackendSchema.optional().default("memory"),
    path: z.string().optional(),
    /** Bound checkpoint history. Omitted means the default retention policy. */
    retention: CheckpointRetentionSchema.optional(),
  }).optional(),
  /** Scoped durable memory (see RuntimeMemorySchema). */
  memory: RuntimeMemorySchema.optional(),
  /** Embedded HTTP ingress for `wait` nodes with `webhook: true`. */
  webhookServer: strictObject({
    /** Default 8878. Use 0 for an OS-assigned ephemeral port. */
    port: z.number().int().nonnegative().optional(),
    /** Default 127.0.0.1. */
    host: z.string().optional(),
    /**
     * Shared secret for this graph's webhook routes. When set, inbound GET/POST
     * must send `Authorization: Bearer <token>` or `X-Flowgraph-Token: <token>`.
     */
    token: z.string().optional(),
  }).optional(),
  /**
   * Background `service` node lifecycle.
   * When terminateOnEnd is true (default), non-keepAlive services are stopped
   * when a run reaches completed/error (not on HITL interrupt/pause).
   */
  services: strictObject({
    terminateOnEnd: z.boolean().optional().default(true),
    /** Re-spawn persisted service intents after process restart. Default false. */
    rehydrateOnResume: z.boolean().optional().default(false),
  }).optional(),
  /**
   * Authoritative filesystem root for providers, localTools, and shell/worktree.
   * Absolute or graph-directory-relative. Falls back to the graph file directory / `--cwd`.
   */
  workspace: z.string().optional(),
  worktrees: strictObject({
    /** Remove worktrees created this run when the graph completes (not on HITL pause). */
    cleanupOnEnd: z.boolean().optional().default(false),
    /**
     * Directory worktree paths must live under (absolute or workspace-relative).
     * Defaults to runtime.workspace.
     */
    root: z.string().optional(),
  }).optional(),
  hitl: strictObject({
    breakpoints: strictObject({
      before: z.array(z.string()).optional(),
      after: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
  retry: RetrySchema.optional(),
  timeoutDefault: DurationSchema.optional(),
  concurrency: z.number().int().positive().optional(),
  /** Max LangGraph supersteps before abort (graph-level loops). Default: 25. */
  recursionLimit: z.number().int().positive().optional(),
  budget: strictObject({
    maxUSD: z.number().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    onExceed: z.union([z.literal("interrupt"), z.literal("fail"), z.literal("warn")]).optional(),
  }).optional(),
  /** Graph-wide defaults for every agent node's `with.context`. */
  context: RuntimeContextSchema.optional(),
  secrets: strictObject({
    redact: strictObject({
      patterns: z.array(z.string()).optional(),
      headers: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
  hooks: z
    .array(
      strictObject({
        on: z.string(),
        where: strictObject({
          nodeId: z.string().optional(),
          nodeType: z.string().optional(),
          tool: z.string().optional(),
          channel: z.string().optional(),
        }).optional(),
        do: z.string(),
        reason: z.string().optional(),
      }).superRefine((hook, ctx) => {
        if (!hookEventFires(hook.on)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["on"],
            message: `Unknown hook event "${hook.on}".`,
          });
          return;
        }
        if (!hookVerbAllowed(hook.on, hook.do)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["do"],
            message: `Hook directive "${hook.do}" is not valid for ${hook.on}. ${hookVerbMessage(hook.on)}`,
          });
        }
      }),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// Run `inputs` schema (pre-start parameters — not HITL)
// ---------------------------------------------------------------------------

export const InputFieldTypeSchema = z.enum(["string", "number", "boolean", "select", "json"], {
  errorMap: (issue, ctx) =>
    ctx.data === "text"
      ? { message: "input type text was removed; use type: string with ui: { widget: textarea }" }
      : issue.code === "invalid_enum_value"
        ? { message: "expected one of string | number | boolean | select | json" }
        : { message: ctx.defaultError },
});

/**
 * One declared run parameter, and the whole contract for it: its `type`, whether it is
 * `required`, its `default`, and (for `json`) an optional draft-07 `schema`. Presentation
 * hints live apart, under `ui`. A declared key is also a state channel the value is seeded into.
 */
export const InputFieldSchema = strictObject({
  key: z.string().min(1),
  type: InputFieldTypeSchema.optional().default("string"),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
  options: z.array(z.string()).optional(),
  schema: DataSchemaSchema.optional().describe("JSON Schema (draft-07) the value must match; only for type: json"),
  ui: FormFieldHintSchema.optional().describe("Presentation hints for forms (label, placeholder, help, widget); not part of the contract"),
  label: relocatedField("input label moved to ui.label"),
})
  .superRefine((field, ctx) => {
    if (field.schema !== undefined && field.type !== "json") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schema"], message: "schema is only allowed on type: json inputs" });
    }
  });

/**
 * A value a graph returns to its caller: the child channel `key`, optionally with its own
 * contract. Declared on a subgraph file, it is checked when the subgraph returns and is the
 * only part of the child the parent can read.
 */
export const OutputFieldSchema = strictObject({
  key: z.string().min(1).describe("Channel of this graph that holds the value"),
  type: ChannelTypeSchema.optional(),
  schema: DataSchemaSchema.optional().describe("JSON Schema (draft-07) the value must match"),
  required: z.boolean().optional().describe("Default true: the graph must have produced a value (not null) for this key"),
  description: z.string().optional(),
})
  .superRefine((field, ctx) => {
    if (!field.schema) return;
    const conflict = channelTypeConflict({ type: field.type, schema: field.schema });
    if (conflict) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schema"], message: conflict });
  });

export type InputField = z.infer<typeof InputFieldSchema>;
export type InputFieldType = z.infer<typeof InputFieldTypeSchema>;
export type OutputField = z.infer<typeof OutputFieldSchema>;

// ---------------------------------------------------------------------------
// Declared secrets
// ---------------------------------------------------------------------------

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Host environment variables the graph may read: `{{ secret.NAME }}` and
 * provider `apiKeyEnv`. Any other name is refused. The host supplies the values.
 */
export const SecretsSchema = z
  .array(z.string().regex(SECRET_NAME_PATTERN, "Invalid secret name: use an environment variable name such as GITHUB_TOKEN"))
  .superRefine((names, ctx) => {
    const seen = new Set<string>();
    names.forEach((name, index) => {
      if (seen.has(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: `Secret "${name}" is declared more than once` });
      seen.add(name);
    });
  });

// ---------------------------------------------------------------------------
// Root Graph spec
// ---------------------------------------------------------------------------

/** Namespaced key of an `extensions` entry: `<vendor>.<name>`, such as `acme.review`. */
export const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;

/**
 * Data a tool or host keeps in a graph file that the engine itself does not read. The only
 * place in a graph where keys flowgraph does not define may live: every key is
 * namespaced (`vendor.name`), and the value is yours.
 */
export const ExtensionsSchema = z.record(
  z.string().regex(EXTENSION_KEY_PATTERN, "extension keys are namespaced as <vendor>.<name>, such as acme.review"),
  z.unknown(),
);

export const GraphRequiresSchema = strictObject({
  engine: z
    .string()
    .min(1)
    .superRefine((range, ctx) => {
      const problem = engineRangeProblem(range);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    })
    .describe("Semver range of the flowgraph engine this graph needs, such as >=0.2.0 <0.4.0"),
});

export const GraphSpecObjectSchema = z.object({
  apiVersion: VersionSchema,
  kind: z.literal("Graph"),
  metadata: MetadataSchema,
  /** What this graph needs from the host that runs it. */
  requires: GraphRequiresSchema.optional(),
  /** The only place for data this schema does not define. Keys are namespaced `vendor.name`. */
  extensions: ExtensionsSchema.optional(),
  /**
   * Host-interpreted auto-start conditions (cron, startup, flow-complete, …).
   * The engine does not schedule these. Flowgraph Desktop interprets them;
   * the CLI, server, and compiled.run() warn that they ignore them.
   */
  triggers: z.array(TriggerSchema).optional(),
  imports: z.array(ImportSpecSchema).optional(),
  mcpServers: z.record(McpServerSchema).optional(),
  providers: ProvidersSchema.optional(),
  config: ConfigSchema.optional(),
  state: StateSchema.optional(),
  /**
   * Typed run parameters collected before start (CLI `--input`, desktop Start form).
   * Distinct from mid-run HITL interrupts.
   */
  inputs: z.array(InputFieldSchema).optional(),
  /**
   * What this graph returns to a caller. Checked when the graph runs as a subgraph, and then the only
   * channels the parent can read. A top-level run does not check it.
   */
  outputs: z.array(OutputFieldSchema).optional(),
  input: relocatedField(
    "top-level input was removed; give the matching inputs entry a default (and declare the key there if it is not an input yet)",
  ),
  nodes: z.array(NodeSpecSchema),
  edges: z.array(EdgeSpecSchema),
  /** Host environment variables this graph may read (see SecretsSchema). */
  secrets: SecretsSchema.optional(),
  runtime: RuntimeSchema.optional(),
});

const coreGraphKeys = new Set(Object.keys(GraphSpecObjectSchema.shape));
const graphExtensionSchemas = new Map<string, z.ZodTypeAny>();

/** Register a top-level graph extension schema (e.g. `localTools` from `@flowgraph/tools-fs`). */
export function registerGraphExtensionSchema(key: string, schema: z.ZodTypeAny): void {
  graphExtensionSchemas.set(key, schema);
}

/** Unregister a top-level graph extension schema (primarily for tests). */
export function unregisterGraphExtensionSchema(key: string): void {
  graphExtensionSchemas.delete(key);
}

/** Schemas registered for top-level graph keys beyond the core ones, by key. */
export function registeredGraphExtensionSchemas(): ReadonlyMap<string, z.ZodTypeAny> {
  return graphExtensionSchemas;
}

/** Known top-level graph keys (core + registered extensions), for typo suggestions. */
export function graphSpecKnownKeys(): string[] {
  return [...coreGraphKeys, ...graphExtensionSchemas.keys()];
}

export const GraphSpecSchema = GraphSpecObjectSchema.passthrough().superRefine((val, ctx) => {
  const unknown: string[] = [];
  for (const key of Object.keys(val)) {
    if (coreGraphKeys.has(key)) continue;
    const ext = graphExtensionSchemas.get(key);
    if (!ext) {
      unknown.push(key);
      continue;
    }
    const parsed = ext.safeParse(val[key]);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: [key, ...issue.path] });
      }
    }
  }
  if (unknown.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.unrecognized_keys,
      keys: unknown,
      path: [],
    });
  }
});

export type GraphSpec = Omit<z.infer<typeof GraphSpecObjectSchema>, "nodes"> & {
  nodes: NodeSpec[];
};

/** NodeSpec with optional inline `spec` typed as GraphSpec (recursive). */
export type NodeSpec = Omit<z.infer<typeof NodeSpecSchema>, "spec"> & {
  /** Inline embedded subgraph (see NodeSpecSchema.spec). */
  spec?: GraphSpec;
};

export type ProviderConfig = z.infer<typeof CoreProviderConfigSchema>;
export type LangChainProviderConfig = z.infer<typeof LangChainProviderConfigSchema>;
export type ClaudeProviderConfig = z.infer<typeof ClaudeProviderConfigSchema>;
export type CursorProviderConfig = z.infer<typeof CursorProviderConfigSchema>;
export type CliProviderConfig = z.infer<typeof CliProviderConfigSchema>;
export type DeepAgentsProviderConfig = z.infer<typeof DeepAgentsProviderConfigSchema>;
export type PluginProviderConfig = z.infer<typeof PluginProviderConfigSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type CliVendor = z.infer<typeof CliVendorSchema>;
export type LangChainVendor = z.infer<typeof LangChainVendorSchema>;

// ---------------------------------------------------------------------------
// Diagnostic (validation result)
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  /** Declaring source file when a diagnostic belongs outside the graph document. */
  file?: string;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** dot-path into the spec object, e.g. "nodes[2].with.prompt" */
  path?: string;
}

export function isError(d: Diagnostic): boolean {
  return d.severity === "error";
}
