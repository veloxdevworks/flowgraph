import { z } from "zod";
import { contractSchemaProblem } from "./validate-json-schema.js";
import { hookEventFires, hookVerbAllowed, hookVerbMessage } from "./hooks.js";

// ---------------------------------------------------------------------------
// Primitives & shared
// ---------------------------------------------------------------------------

export const VersionSchema = z.literal("flowgraph/v1");
export const KindSchema = z.union([z.literal("Graph"), z.literal("Skill"), z.literal("Subgraph")]);

export const MetadataSchema = z.object({
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

const TriggerBaseSchema = z.object({
  /** Stable id within this graph (used by hosts for dedupe / disable). */
  id: z.string().min(1),
  /** When false, hosts ignore the trigger. Default true. */
  enabled: z.boolean().optional(),
});

export const CronTriggerSchema = TriggerBaseSchema.extend({
  type: z.literal("cron"),
  /** Standard 5-field cron expression (minute hour day-of-month month day-of-week). */
  schedule: z.string().min(1),
  /** IANA timezone (e.g. "America/Denver"). Host default when omitted. */
  timezone: z.string().optional(),
});

export const IntervalTriggerSchema = TriggerBaseSchema.extend({
  type: z.literal("interval"),
  every: z.number().positive(),
  unit: z.enum(["seconds", "minutes", "hours"]),
});

export const StartupTriggerSchema = TriggerBaseSchema.extend({
  type: z.literal("startup"),
});

export const FlowCompleteTriggerSchema = TriggerBaseSchema.extend({
  type: z.literal("flow-complete"),
  /** Target graph `metadata.name` (kebab-case). */
  graph: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "graph must be kebab-case"),
});

export const FlowFailedTriggerSchema = TriggerBaseSchema.extend({
  type: z.literal("flow-failed"),
  /** Target graph `metadata.name` (kebab-case). */
  graph: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "graph must be kebab-case"),
});

export const WebhookTriggerSchema = TriggerBaseSchema.extend({
  type: z.literal("webhook"),
  /**
   * URL path segment under the host's trigger ingress (e.g. "/hooks/my-graph").
   * When omitted, hosts typically derive a slug from `metadata.name`.
   */
  path: z.string().optional(),
});

export const FileWatchTriggerSchema = TriggerBaseSchema.extend({
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
export const FormFieldHintSchema = z
  .object({
    label: z.string().optional(),
    placeholder: z.string().optional(),
    help: z.string().optional(),
    widget: z.enum(["text", "textarea", "password", "select", "radio", "checkbox"]).optional(),
  })
  .strict();

/** Presentation hints for a form, keyed by top-level schema property; `order` lists fields first-to-last. */
export const FormUiSchema = z
  .object({
    order: z.array(z.string()).optional(),
    fields: z.record(FormFieldHintSchema).optional(),
  })
  .strict();

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

export const ChannelSchema = z.object({
  type: ChannelTypeSchema,
  description: z.string().optional(),
  default: z.unknown().optional(),
  reducer: ReducerSchema.optional(),
  items: PropertySchema.optional(),
  properties: z.record(PropertySchema).optional(),
});

export const StateSchema = z.object({
  channels: z.record(ChannelSchema),
});

// ---------------------------------------------------------------------------
// Retry / timeout
// ---------------------------------------------------------------------------

export const BackoffSchema = z.union([
  z.literal("fixed"),
  z.literal("linear"),
  z.literal("exponential"),
]);

export const RetrySchema = z.object({
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
export const OutputMappingObjectSchema = z.object({
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
  none: z.undefined().optional(),
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

export const OutputMappingSchema = z
  .union([z.literal("none"), OutputMappingObjectSchema], {
    errorMap: (_issue, ctx) => ({ message: outputMappingFormError(ctx.data) ?? OUTPUT_MAPPING_FORMS }),
  })
  .superRefine((value, ctx) => {
    if (typeof value !== "object") return;
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

export const MemoryScopeSchema = z.enum(["org", "project", "graph", "user", "subject"], {
  errorMap: (issue, ctx) =>
    issue.code === "invalid_enum_value"
      ? { message: `must be one of org | project | graph | user | subject (got "${String(issue.received)}")` }
      : { message: ctx.defaultError },
});

// ── agent memory (recall + remember) ──────────────────────────────────────

/** Identifier usable as `{{ memory.<id> }}`. */
const RecallIdSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "recall id must be an identifier ([A-Za-z_][A-Za-z0-9_]*)");

export const SimilarSubjectsSchema = z
  .object({
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
  })
  .strict();

export const MemoryRecallBlockSchema = z
  .object({
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
  .strict()
  .superRefine((b, ctx) => {
    if (b.similarSubjects && (b.scopes || b.dedupe !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a similarSubjects block cannot also set scopes or dedupe", path: ["scopes"] });
    }
  });

export const AgentMemoryWritesSchema = z
  .object({
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
  })
  .strict();

export const AgentMemorySchema = z
  .object({
    /** Token budget for all recalled memory in this node (estimated bytes/4; default 1000, cap 4000). */
    maxTokens: z.number().int().positive().optional(),
    /** Max recalled items across all blocks (default 20, max 200). */
    maxItems: z.number().int().min(1).max(200).optional(),
    recall: z.array(MemoryRecallBlockSchema).optional(),
    /** Enables the builtin `remember` tool. */
    agentWrites: AgentMemoryWritesSchema.optional(),
  })
  .strict();

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

export const ContextSummarizeSchema = z
  .object({
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
  })
  .strict();

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

export const RuntimeContextSchema = z.object(contextPolicyFields).strict();

export const AgentContextSchema = z
  .object({
    ...contextPolicyFields,
    /** A `type: messages` channel holding this agent's conversation across steps, loops and runs. */
    history: z.string().min(1).optional(),
    /** What is appended to history per run: the prompt and final reply (turns, default) or every tool turn too (all). */
    record: z.enum(["turns", "all"]).optional(),
    /** Remove messages that no longer fit (and store the running summary) in the history channel. Default true. */
    compact: z.boolean().optional(),
  })
  .strict();

// agent node (formerly "intelligent")
const AgentImageSourceSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    detail: z.enum(["auto", "low", "high"]).optional(),
    estimatedTokens: z.number().int().positive().optional(),
  }).passthrough().superRefine((value, ctx) => {
    if ((value.path !== undefined) === (value.url !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An image requires exactly one of path or url" });
    }
  }),
]);

export const AgentWithSchema = BaseWithSchema.extend({
  streaming: z.boolean().optional(),
  /** Reference to a reusable agent definition (AGENT.md), resolved at run time. */
  agent: z.string().optional(),
  system: z.string().optional(),
  prompt: z.string(),
  images: z.union([AgentImageSourceSchema, z.array(AgentImageSourceSchema).max(16)]).optional()
    .describe("Image paths, URLs, data URLs or Artifact references; templates may resolve to a list."),
  tools: z
    .array(
      z.union([
        z.object({ skill: z.string() }),
        z.object({ node: z.string() }),
        z.object({ function: z.string() }),
        z.object({ builtin: z.array(z.string()) }),
        z.object({ mcp: z.string(), tools: z.array(z.string()).optional() }),
      ]),
    )
    .optional(),
  schema: ContractSchemaSchema.optional(),
  maxSteps: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  permission: z.union([z.literal("auto"), z.literal("ask"), z.literal("deny")]).optional(),
  /**
   * Optional hub implementation for this agent node. `deepagents` reuses the
   * graph's LangChain ChatModel/key (see `@flowgraph/provider-deepagents`).
   */
  hub: z.enum(["deepagents"]).optional(),
  /** Long-term memory: recall into the prompt within a token budget, and the `remember` tool. */
  memory: AgentMemorySchema.optional(),
  /** Context budget and history management (see AgentContextSchema). */
  context: AgentContextSchema.optional(),
  // provider-namespaced escape hatches (any shape)
  claude: z.record(z.unknown()).optional(),
  cursor: z.record(z.unknown()).optional(),
  langchain: z.record(z.unknown()).optional(),
  deepagents: z.record(z.unknown()).optional(),
});

/** @deprecated Use AgentWithSchema */
export const IntelligentWithSchema = AgentWithSchema;

// skill node
export const SkillWithSchema = BaseWithSchema;

// router node — routes are an ordered list so YAML order is the match order
export const RouterRouteSchema = z.object({
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

export const RouterWithSchema = z
  .object({
    mode: z.union([z.literal("rules"), z.literal("model")]).default("rules"),
    input: z.string().optional(),
    instruction: z.string().optional(),
    provider: z.string().optional(),
    routes: z.array(RouterRouteSchema, {
      invalid_type_error: "routes must be a list of - name: entries",
      required_error: "routes must be a list of - name: entries",
    }).min(1),
    match: z.union([z.literal("firstMatch"), z.literal("allMatches")]).optional().default("firstMatch"),
    output: OutputMappingSchema.optional(),
  })
  .superRefine((value, ctx) => {
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
export const HttpWithSchema = BaseWithSchema.extend({
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
  expect: z.object({ status: z.array(z.number()) }).optional(),
  once: z
    .boolean()
    .optional()
    .describe("Send at most once per run (idempotent across checkpoint replays)"),
  timeout: relocatedField(
    "http with.timeout is not supported; set timeout on the node, or runtime.timeoutDefault as a graph default",
  ),
  retry: relocatedField(
    "http with.retry is not supported; set retry on the node, or runtime.retry as a graph default",
  ),
});

export const ToolRequireSchema = z.object({
  bin: z.string().min(1).describe("Binary that must be on PATH"),
  version: z.string().optional().describe("Human-readable constraint, e.g. \">=1.22\""),
});

export const OnMissingToolSchema = z
  .union([z.literal("fail"), z.literal("skip")])
  .optional()
  .default("fail")
  .describe("fail (default) throws; skip records a TOOL_NOT_FOUND issue and continues");

// function node (formerly "code") — legacy programmatic escape hatch
export const FunctionWithSchema = BaseWithSchema.extend({
  fn: z.string().describe("Registered function name"),
  input: z.record(z.string()).optional(),
});

// memory node — read/write scoped durable memory (requires runtime.memory)
export const MemoryOpSchema = z.enum(["get", "search", "put", "patch", "increment", "append", "delete"]);

export const MemoryWithSchema = BaseWithSchema.extend({
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
  if (v.op !== "search" && !v.key) ctx.addIssue({ code: "custom", path: ["key"], message: `op "${v.op}" requires key` });
  if ((v.op === "put" || v.op === "patch" || v.op === "append") && v.value === undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: `op "${v.op}" requires value` });
  }
  if ((v.op === "get" || v.op === "search") && v.scope !== undefined && v.scopes !== undefined) {
    ctx.addIssue({ code: "custom", path: ["scope"], message: "use either scope or scopes, not both" });
  }
});

/** @deprecated Use FunctionWithSchema */
export const CodeWithSchema = FunctionWithSchema;

// shell node — run a program with argv (no shell), or a fixed command line through the OS shell with `shell: true`
export const ShellWithSchema = BaseWithSchema.extend({
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
  input: z.record(z.unknown()).optional().describe("Rendered, passed via FLOWGRAPH_INPUT env + stdin JSON"),
  timeout: relocatedField(
    "shell with.timeout is not supported; set timeout on the node, or runtime.timeoutDefault as a graph default",
  ),
  expect: z.object({ exitCode: z.array(z.number()).optional() }).optional(),
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

export const FailWithSchema = z.object({
  reason: z.string().regex(/\S/, "A failure reason is required")
    .describe("Failure reason; templates render against the node's state and input."),
});

// script node — sandboxed Node.js (ESM) source
export const ScriptPermissionsSchema = z.object({
  fsRead: z.array(z.string()).optional().describe("Paths granted via --allow-fs-read"),
  fsWrite: z.array(z.string()).optional().describe("Paths granted via --allow-fs-write"),
  childProcess: z.boolean().optional().describe("When true, grants --allow-child-process"),
  workerThreads: z.boolean().optional().describe("When true, grants --allow-worker"),
});

export const ScriptWithSchema = BaseWithSchema.extend({
  code: z
    .string()
    .regex(/\S/, "Script code must not be empty")
    .optional()
    .describe("Self-contained Node.js ESM source with a default-export function; mutually exclusive with file."),
  file: z.string().trim().min(1).optional().describe("Self-contained ESM source file, relative to the declaring graph; mutually exclusive with code."),
  input: z.record(z.unknown()).optional().describe("Structured input, with templates rendered recursively and value types preserved"),
  env: z.record(z.string()).optional().describe("Environment variables available to the child process"),
  timeout: relocatedField(
    "script with.timeout is not supported; set timeout on the node, or runtime.timeoutDefault as a graph default",
  ),
  permissions: ScriptPermissionsSchema.optional(),
  requires: z.array(ToolRequireSchema).optional(),
  onMissingTool: OnMissingToolSchema,
}).superRefine((value, ctx) => {
  if ((value.code !== undefined) === (value.file !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "script: provide exactly one of code or file" });
  }
});

// subgraph node
export const SubgraphWithSchema = BaseWithSchema.extend({
  stateMap: z
    .object({
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
    .optional()
    .describe("Explicit projection between parent and child channels"),
});

// map node
export const MapWithSchema = z.object({
  memoize: z.union([z.boolean(), z.object({
    key: z.string().optional(), version: z.string().optional(),
    maxEntries: z.number().int().positive().max(10000).optional(),
    maxBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
  })]).optional().describe("Reuse completed item results across loop rounds; opt in only for deterministic item work"),
  over: z.string().describe("Expression evaluating to an array"),
  as: z.string().default("item"),
  concurrency: z.number().int().positive().optional().default(5),
  node: z
    .lazy((): typeof MapBodyNodeSchema => MapBodyNodeSchema)
    .describe("The node run once per item: a node spec whose id is optional"),
  collect: OutputMappingSchema.optional(),
});

/** A hitl route target: a node id, or `{ to, description }`. */
export const HitlRouteSchema = z.union([
  z.string(),
  z.object({ to: z.string(), description: z.string().optional() }),
]);

// hitl node — human-in-the-loop gate (approve, question, choice, form, review)
export const HitlWithSchema = BaseWithSchema.extend({
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
  diff: z
    .object({
      cwd: z.string().optional(),
      base: z.string().optional(),
      paths: z.array(z.string()).optional(),
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .optional(),
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
});

// wait node — deadline / until / signal / webhook (inbound HTTP resume)
export const WaitWithSchema = BaseWithSchema.extend({
  deadline: DurationSchema.optional().describe("In-process sleep. Not durable across a restart."),
  duration: relocatedField("wait with.duration is not supported; rename it to deadline"),
  until: z.string().optional(),
  signal: z.string().optional().describe("Resume only when the payload names this signal"),
  timeout: DurationSchema.optional(),
  /** When set, interrupt and listen for an inbound HTTP POST to resume. */
  webhook: z
    .union([
      z.literal(true),
      z.object({ schema: ContractSchemaSchema.optional() }),
    ])
    .optional(),
});

// mcp node — deterministic MCP tool/resource call
export const McpWithSchema = BaseWithSchema.extend({
  server: z.string().describe("MCP server name from mcpServers"),
  tool: z.string().optional().describe("Tool name to call"),
  resource: z.string().optional().describe("Resource URI to read"),
  arguments: z.record(z.unknown()).optional().describe("Tool arguments (supports {{ }} templates)"),
});

// MCP server connection (top-level mcpServers block)
export const McpAuthSchema = z.object({
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

export const McpServerSchema = z.union([
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    auth: McpAuthSchema.optional(),
  }),
  z.object({
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

export const RunsOnObjectSchema = z
  .object({
    labels: z.array(PlacementLabelSchema).min(1).describe("All of these labels must match"),
    target: z.string().min(1).optional().describe("Pin to one named target from the topology"),
    fallback: z
      .enum(["error", "local"])
      .optional()
      .describe("`local` runs the node here when no worker matches (default: error)"),
    wait: relocatedField(
      "runsOn.wait is not supported; queueing for a matching worker is not available. Remove wait, or make a matching worker available now.",
    ),
  })
  .strict();

export const RunsOnSchema = z.union([z.array(PlacementLabelSchema).min(1), RunsOnObjectSchema]);

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
  return {
    labels: [...new Set(value.labels)],
    ...(value.target !== undefined ? { target: value.target } : {}),
    fallback: value.fallback ?? "error",
    ...(value.wait !== undefined ? { wait: value.wait } : {}),
  };
}

// ---------------------------------------------------------------------------
// Node spec (generic — `with` is typed per-type after resolution)
// ---------------------------------------------------------------------------

export const NodeSpecSchema = z.object({
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
  toolInput: z
    .record(z.unknown())
    .optional()
    .describe("JSON Schema for agent tool-call arguments when this node is used as a tool"),
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
  input: z.record(z.string()).optional(),
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
  on: z
    .object({
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
    })
    .optional(),
}).strict();

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

export const BranchSchema = z.object({
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

export const EdgeSpecSchema = z.union([
  // static edge. `from` as a list compiles to one multi-source barrier.
  z.object({
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
  z.object({
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
]);

export type EdgeSpec = z.infer<typeof EdgeSpecSchema>;

// ---------------------------------------------------------------------------
// Import spec
// ---------------------------------------------------------------------------

export const ImportSpecSchema = z.union([
  z.object({ skill: z.string(), as: z.string().optional() }),
  z.object({ agent: z.string(), as: z.string().optional() }),
  z.object({ subgraph: z.string(), as: z.string().optional() }),
  z.object({ nodes: z.string() }),
  z.object({ providers: z.string() }),
  z.object({ reducers: z.string() }),
]);

// ---------------------------------------------------------------------------
// Config block
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  defaults: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      retry: relocatedField(
        "config.defaults.retry is not supported; set retry on the node, or runtime.retry as a graph default",
      ),
      timeout: relocatedField(
        "config.defaults.timeout is not supported; set timeout on the node, or runtime.timeoutDefault as a graph default",
      ),
    })
    .optional(),
  vars: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Providers block (LLM backends for intelligent nodes)
// ---------------------------------------------------------------------------

export const LangChainVendorSchema = z.enum([
  "openai",
  "anthropic",
  "xai",
  "ollama",
  "google",
  "bedrock",
]);

export const LangChainProviderConfigSchema = z.object({
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

export const ClaudeProviderConfigSchema = z.object({
  kind: z.literal("claude"),
  model: z.string().optional(),
  permissionMode: ClaudePermissionModeSchema.optional(),
  cwd: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export const CursorRuntimeSchema = z.enum(["local", "cloud"]);

export const CursorProviderConfigSchema = z.object({
  kind: z.literal("cursor"),
  model: z.string().optional(),
  runtime: CursorRuntimeSchema.optional(),
  apiKeyEnv: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export const CliVendorSchema = z.enum(["claude", "cursor", "codex", "grok"]);

/** Local agent CLI (Claude Code, Cursor CLI, Codex, Grok Build) — no API key required. */
export const CliProviderConfigSchema = z.object({
  kind: z.literal("cli"),
  vendor: CliVendorSchema,
  model: z.string().optional(),
  cwd: z.string().optional(),
  /** Override binary name/path (defaults: claude, cursor-agent, codex, grok). */
  binary: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export const DeepAgentsProviderConfigSchema = z.object({
  kind: z.literal("deepagents"),
  /** Inherit ChatModel from this providers.* entry (default: graph defaults.provider). */
  modelProvider: z.string().optional(),
  model: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export const CoreProviderConfigSchema = z.discriminatedUnion("kind", [
  LangChainProviderConfigSchema,
  ClaudeProviderConfigSchema,
  CursorProviderConfigSchema,
  CliProviderConfigSchema,
  DeepAgentsProviderConfigSchema,
]);

const extensionProviderKindSchemas = new Map<string, z.ZodTypeAny>();

/** Register a provider config schema for a non-core provider kind (e.g. `kind: media`). */
export function registerProviderKindSchema(kind: string, schema: z.ZodTypeAny): void {
  extensionProviderKindSchemas.set(kind, schema);
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

/**
 * Long-term store backends. `memory` is process-local and ephemeral; `none` disables
 * `ctx.store`. `sqlite` / `postgres` are reserved for the durable store and fail at
 * compile time until a store instance is injected — there is no silent in-memory fallback.
 */
export const StoreBackendSchema = z.enum(["memory", "none", "sqlite", "postgres"], {
  errorMap: (issue, ctx) =>
    issue.code === "invalid_enum_value"
      ? { message: `must be one of memory | none | sqlite | postgres (got "${String(issue.received)}")` }
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

export const RuntimeMemorySchema = z
  .object({
    backend: MemoryBackendSchema.optional().default("checkpoint"),
    subject: z
      .object({
        /** Subject type, e.g. incident, build, ticket. */
        type: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, "must match ^[a-z][a-z0-9_-]{0,63}$"),
        /** Template rendered at run start from input/run only. */
        key: z.string().min(1),
        required: z.boolean().optional().default(false),
        /** Sliding TTL, refreshed on every write to the subject. */
        ttl: DurationSchema.optional().default("180d"),
        /** Store sha256 of the rendered key instead of the key. */
        hash: z.boolean().optional().default(false),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        itemBytes: z.number().int().positive().optional(),
        itemsPerScope: z.number().int().positive().optional(),
        bytesPerScope: z.number().int().positive().optional(),
        subjectsPerType: z.number().int().positive().optional(),
        onFull: z.enum(["evict-oldest", "reject"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const CheckpointRetentionSchema = z.union([
  z.boolean(),
  z
    .object({
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
    })
    .strict(),
]);

export const RuntimeSchema = z.object({
  checkpoint: z
    .object({
      enabled: z.boolean().optional().default(true),
      backend: CheckpointBackendSchema.optional().default("memory"),
      path: z.string().optional(),
      namespace: relocatedField(
        "runtime.checkpoint.namespace is not supported; checkpoints are already kept per thread. Remove it.",
      ),
      /** Bound checkpoint history. Omitted means the default retention policy. */
      retention: CheckpointRetentionSchema.optional(),
    })
    .optional(),
  store: z
    .object({
      enabled: z.boolean().optional().default(true),
      backend: StoreBackendSchema.optional().default("memory"),
    })
    .optional(),
  /** Scoped durable memory (see RuntimeMemorySchema). Mutually exclusive with `store`. */
  memory: RuntimeMemorySchema.optional(),
  /** Embedded HTTP ingress for `wait` nodes with `webhook: true`. */
  webhookServer: z
    .object({
      /** Default 8878. Use 0 for an OS-assigned ephemeral port. */
      port: z.number().int().nonnegative().optional(),
      /** Default 127.0.0.1. */
      host: z.string().optional(),
      /**
       * Shared secret for this graph's webhook routes. When set, inbound GET/POST
       * must send `Authorization: Bearer <token>` or `X-Flowgraph-Token: <token>`.
       */
      token: z.string().optional(),
    })
    .optional(),
  /**
   * Background `service` node lifecycle.
   * When terminateOnEnd is true (default), non-keepAlive services are stopped
   * when a run reaches completed/error (not on HITL interrupt/pause).
   */
  services: z
    .object({
      terminateOnEnd: z.boolean().optional().default(true),
      /** Re-spawn persisted service intents after process restart. Default false. */
      rehydrateOnResume: z.boolean().optional().default(false),
    })
    .optional(),
  /**
   * Authoritative filesystem root for providers, localTools, and shell/worktree.
   * Absolute or graph-directory-relative. Falls back to the graph file directory / `--cwd`.
   */
  workspace: z.string().optional(),
  worktrees: z
    .object({
      /** Remove worktrees created this run when the graph completes (not on HITL pause). */
      cleanupOnEnd: z.boolean().optional().default(false),
      /**
       * Directory worktree paths must live under (absolute or workspace-relative).
       * Defaults to runtime.workspace.
       */
      root: z.string().optional(),
    })
    .optional(),
  hitl: z
    .object({
      onInterrupt: relocatedField(
        "runtime.hitl.onInterrupt is not a graph setting; the host decides how interrupts are answered (CLI --on-interrupt, or onInterrupt in run options). Remove it.",
      ),
      breakpoints: z
        .object({
          before: z.array(z.string()).optional(),
          after: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  retry: RetrySchema.optional(),
  timeoutDefault: DurationSchema.optional(),
  concurrency: z.number().int().positive().optional(),
  /** Max LangGraph supersteps before abort (graph-level loops). Default: 25. */
  recursionLimit: z.number().int().positive().optional(),
  budget: z
    .object({
      maxUSD: z.number().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      onExceed: z.union([z.literal("interrupt"), z.literal("fail"), z.literal("warn")]).optional(),
    })
    .optional(),
  /** Graph-wide defaults for every agent node's `with.context`. */
  context: RuntimeContextSchema.optional(),
  secrets: z
    .object({
      provider: relocatedField(
        "runtime.secrets.provider is not supported; list the names the graph reads under the top-level secrets: and let the host supply their values.",
      ),
      redact: z
        .object({
          patterns: z.array(z.string()).optional(),
          headers: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  observability: relocatedField(
    "runtime.observability is not a graph setting; configure logging and OpenTelemetry in the host (FLOWGRAPH_LOG_LEVEL, event sinks). Remove it.",
  ),
  hooks: z
    .array(
      z
        .object({
          on: z.string(),
          where: z
            .object({
              nodeId: z.string().optional(),
              nodeType: z.string().optional(),
              tool: z.string().optional(),
              channel: z.string().optional(),
            })
            .strict()
            .optional(),
          do: z.string(),
          reason: z.string().optional(),
        })
        .superRefine((hook, ctx) => {
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

export const InputFieldTypeSchema = z.enum([
  "string",
  "text",
  "number",
  "boolean",
  "select",
  "json",
]);

export const InputFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  type: InputFieldTypeSchema.optional().default("string"),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export type InputField = z.infer<typeof InputFieldSchema>;
export type InputFieldType = z.infer<typeof InputFieldTypeSchema>;

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

export const GraphSpecObjectSchema = z.object({
  apiVersion: VersionSchema,
  kind: z.literal("Graph"),
  metadata: MetadataSchema,
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
  /** Default run input seeded when a run starts (desktop Start inspector / CLI may override). */
  input: z.record(z.unknown()).optional(),
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
