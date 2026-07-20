import { z } from "zod";

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

// A JSON-schema-compatible type for channel/contract declarations
export const JsonSchemaTypeSchema = z.union([
  z.literal("string"),
  z.literal("number"),
  z.literal("boolean"),
  z.literal("object"),
  z.literal("array"),
  z.literal("null"),
  z.literal("any"),
]);

// Inline property schema used in skill inputs/outputs and node schema:
export const PropertySchema: z.ZodType<PropertyDef, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    type: JsonSchemaTypeSchema.optional(),
    description: z.string().optional(),
    enum: z.array(z.unknown()).optional(),
    default: z.unknown().optional(),
    required: z.boolean().optional(),
    items: PropertySchema.optional(),
    properties: z.record(PropertySchema).optional(),
    $ref: z.string().optional(),
  }),
) as z.ZodType<PropertyDef, z.ZodTypeDef, unknown>;
export type PropertyDef = {
  type?: z.infer<typeof JsonSchemaTypeSchema> | undefined;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  required?: boolean;
  items?: PropertyDef;
  properties?: Record<string, PropertyDef>;
  $ref?: string;
};

// ---------------------------------------------------------------------------
// State / channels
// ---------------------------------------------------------------------------

export const ReducerSchema = z.union([
  z.literal("lastWrite"),
  z.literal("append"),
  z.literal("concat"),
  z.literal("merge"),
  z.literal("mergeDeep"),
  z.literal("messages"),
  z.string().startsWith("custom:"),
]);

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

// ---------------------------------------------------------------------------
// Output mapping
// ---------------------------------------------------------------------------

/**
 * How a node's result is written into state.
 *
 * - omitted / `{}` — auto-save to `state.<nodeId>` (see runtime `applyOutput`)
 * - `"none"` / `{ none: true }` — opt out; write nothing
 * - `{ to }` and/or `{ map }` — optional projections, additive with the nodeId slug
 */
export const OutputMappingObjectSchema = z.object({
  /** Write the full result to this channel (in addition to `state.<nodeId>`). */
  to: z.string().optional(),
  /** Project fields from `result` into channels (in addition to `state.<nodeId>`). */
  map: z.record(z.string()).optional(),
  /** When true, write nothing to state (pure side-effect). */
  none: z.boolean().optional(),
});

export const OutputMappingSchema = z.union(
  [z.literal("none"), OutputMappingObjectSchema],
  {
    errorMap: () => ({
      message:
        'expected "none", { none: true }, { to: "<channel>" }, and/or { map: { <channel>: "<expr>" } } — not a bare string or flat field map',
    }),
  },
);

export type OutputMapping = z.infer<typeof OutputMappingSchema>;

// ---------------------------------------------------------------------------
// Node `with` blocks — per-type config
// ---------------------------------------------------------------------------

const BaseWithSchema = z.object({
  output: OutputMappingSchema.optional(),
});

// agent node (formerly "intelligent")
export const AgentWithSchema = BaseWithSchema.extend({
  /** Reference to a reusable agent definition (AGENT.md), resolved at run time. */
  agent: z.string().optional(),
  system: z.string().optional(),
  prompt: z.string(),
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
  schema: z.record(z.unknown()).optional(),
  maxSteps: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  permission: z.union([z.literal("auto"), z.literal("ask"), z.literal("deny")]).optional(),
  // provider-namespaced escape hatches (any shape)
  claude: z.record(z.unknown()).optional(),
  cursor: z.record(z.unknown()).optional(),
  langchain: z.record(z.unknown()).optional(),
});

/** @deprecated Use AgentWithSchema */
export const IntelligentWithSchema = AgentWithSchema;

// skill node
export const SkillWithSchema = BaseWithSchema;

// router node
export const RouterRouteSchema = z.object({
  when: z.string().optional(),
  default: z.boolean().optional(),
  to: z.string(),
  description: z.string().optional(),
});

export const RouterWithSchema = z.object({
  mode: z.union([z.literal("rules"), z.literal("model")]).default("rules"),
  input: z.string().optional(),
  instruction: z.string().optional(),
  provider: z.string().optional(),
  routes: z.record(RouterRouteSchema),
  match: z.union([z.literal("firstMatch"), z.literal("allMatches")]).optional().default("firstMatch"),
  output: OutputMappingSchema.optional(),
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
  timeout: DurationSchema.optional(),
  retry: RetrySchema.optional(),
});

const DemoHttpMethodSchema = z.union([
  z.literal("GET"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
]);

/**
 * Best-effort artifact capture. Exactly one of `http`, `screenshot`, or `file`
 * must be set. Capture failures return `{ ok: false }` unless `strict: true`.
 */
export const DemoWithSchema = BaseWithSchema.extend({
  strict: z
    .boolean()
    .optional()
    .describe("Fail the node instead of returning ok:false on capture failure"),
  label: z.string().optional().describe("Optional human-readable label for the artifact"),
  http: z
    .object({
      method: DemoHttpMethodSchema.default("GET"),
      url: z.string(),
      headers: z.record(z.string()).optional(),
      body: z.unknown().optional(),
      timeout: DurationSchema.optional(),
    })
    .optional(),
  screenshot: z
    .object({
      url: z.string(),
      waitFor: z
        .union([z.string(), DurationSchema])
        .optional()
        .describe("CSS selector or a duration to wait before capture"),
      video: z.boolean().optional(),
      viewport: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional(),
      timeout: DurationSchema.optional(),
    })
    .optional(),
  file: z
    .object({
      path: z.string(),
    })
    .optional(),
}).superRefine((val, ctx) => {
  const modes = [val.http, val.screenshot, val.file].filter((m) => m != null);
  if (modes.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "demo: set exactly one of http, screenshot, or file",
      path: [],
    });
  } else if (modes.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "demo: set only one of http, screenshot, or file",
      path: [],
    });
  }
});

// function node (formerly "code") — legacy programmatic escape hatch
export const FunctionWithSchema = BaseWithSchema.extend({
  fn: z.string().describe("Registered function name"),
  input: z.record(z.string()).optional(),
});

/** @deprecated Use FunctionWithSchema */
export const CodeWithSchema = FunctionWithSchema;

// shell node — run a command (argv-safe) or OS shell string
export const ShellWithSchema = BaseWithSchema.extend({
  command: z.string().describe("Binary/script, or full shell command when args is omitted"),
  args: z.array(z.string()).optional().describe("Argv; when set, runs without a shell"),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  input: z.record(z.unknown()).optional().describe("Rendered, passed via FLOWGRAPH_INPUT env + stdin JSON"),
  timeout: DurationSchema.optional(),
  expect: z.object({ exitCode: z.array(z.number()).optional() }).optional(),
});

// service node — start/stop long-running background processes
export const ServiceReadySchema = z.union([
  // port may be a number or a `{{ }}` template string (coerced at run time)
  z.object({ port: z.union([z.number().int().positive(), z.string().min(1)]) }),
  z.object({
    url: z.string(),
    status: z.array(z.number()).optional(),
  }),
  z.object({ log: z.string() }).describe("Regex matched against combined stdout+stderr"),
]);

// port node — allocate free TCP port(s) at run time
export const PortWithSchema = BaseWithSchema.extend({
  count: z.number().int().positive().optional().default(1),
  preferred: z
    .union([z.number().int().positive(), z.array(z.number().int().positive())])
    .optional()
    .describe("Preferred port(s); falls back to an OS-assigned port when taken"),
  host: z.string().optional().describe("Bind host for the probe (default 127.0.0.1)"),
});

export const ServiceWithSchema = BaseWithSchema.extend({
  name: z.string().min(1).describe("Stable service id within a run/thread"),
  action: z
    .union([
      z.literal("start"),
      z.literal("stop"),
      z.literal("restart"),
      z.literal("status"),
    ])
    .optional()
    .default("start"),
  command: z.string().optional().describe("Required for start/restart"),
  args: z.array(z.string()).optional().describe("Argv; when set, runs without a shell"),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  ready: ServiceReadySchema.optional().describe("Readiness probe before the node completes"),
  readyTimeout: DurationSchema.optional().describe("Default 30s"),
  readyInterval: DurationSchema.optional().describe("Default 300ms"),
  stopSignal: z.string().optional().describe("Default SIGTERM"),
  stopTimeout: DurationSchema.optional().describe("Default 5s before SIGKILL"),
  keepAlive: z
    .boolean()
    .optional()
    .describe("When true, skip auto-stop at run end regardless of runtime.services.terminateOnEnd"),
}).superRefine((val, ctx) => {
  const action = val.action ?? "start";
  if ((action === "start" || action === "restart") && !val.command?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "service: command is required when action is start or restart",
      path: ["command"],
    });
  }
});

// script node — sandboxed inline Node.js (ESM) source
export const ScriptPermissionsSchema = z.object({
  fsRead: z.array(z.string()).optional().describe("Paths granted via --allow-fs-read"),
  fsWrite: z.array(z.string()).optional().describe("Paths granted via --allow-fs-write"),
  childProcess: z.boolean().optional().describe("When true, grants --allow-child-process"),
  workerThreads: z.boolean().optional().describe("When true, grants --allow-worker"),
});

export const ScriptWithSchema = BaseWithSchema.extend({
  code: z
    .string()
    .min(1, "Script code is required")
    .describe("Node.js ESM source. Must `export default async function(input, ctx) { ... }`."),
  input: z.record(z.string()).optional().describe("Rendered templates passed as the script's input argument"),
  env: z.record(z.string()).optional().describe("Environment variables available to the child process"),
  timeout: DurationSchema.optional(),
  permissions: ScriptPermissionsSchema.optional(),
});

// subgraph node
export const SubgraphWithSchema = BaseWithSchema.extend({
  stateMap: z
    .object({
      in: z.record(z.string()).optional(),
      out: z.record(z.string()).optional(),
    })
    .optional(),
});

// map node
export const MapWithSchema = z.object({
  over: z.string().describe("Expression evaluating to an array"),
  as: z.string().default("item"),
  concurrency: z.number().int().positive().optional().default(5),
  node: z.record(z.unknown()),
  collect: OutputMappingSchema.optional(),
});

// hitl node — human-in-the-loop gate (approve, question, choice)
export const HitlWithSchema = BaseWithSchema.extend({
  mode: z.union([z.literal("approve"), z.literal("question"), z.literal("choice")]).default("approve"),
  message: z.string(),
  choices: z.array(z.string()).optional(),
});

// wait node — duration / until / signal / webhook (inbound HTTP resume)
export const WaitWithSchema = BaseWithSchema.extend({
  duration: DurationSchema.optional(),
  until: z.string().optional(),
  signal: z.string().optional(),
  timeout: DurationSchema.optional(),
  /** When set, interrupt and listen for an inbound HTTP POST to resume. */
  webhook: z
    .union([
      z.literal(true),
      z.object({ schema: z.record(z.unknown()).optional() }),
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

// webhook node — outbound HTTP notification only (inbound waits live on `wait`)
export const WebhookWithSchema = BaseWithSchema.extend({
  url: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

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
  with: z.record(z.unknown()).optional(),
  retry: RetrySchema.optional(),
  timeout: DurationSchema.optional(),
  when: z.string().optional().describe("Guard expression — skip node if false"),
  on: z
    .object({
      error: z
        .union([
          z.literal("fail"),
          z.literal("continue"),
          z.literal("ignore"),
          z.string().startsWith("route:"),
        ])
        .optional(),
    })
    .optional(),
});

// NodeSpec is declared after GraphSpec (see below) so `spec?: GraphSpec` can
// close the recursive type without a forward reference.

// ---------------------------------------------------------------------------
// Edge spec
// ---------------------------------------------------------------------------

export const BranchSchema = z.object({
  when: z.string().optional(),
  default: z.boolean().optional(),
  to: z.string(),
  description: z.string().optional(),
});

export const EdgeSpecSchema = z.union([
  // static edge
  z.object({
    from: z.string(),
    to: z.union([z.string(), z.array(z.string())]),
  }),
  // conditional edge
  z.object({
    from: z.string(),
    branch: z.array(BranchSchema),
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
      retry: RetrySchema.optional(),
      timeout: DurationSchema.optional(),
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

export const ProviderConfigSchema = z.discriminatedUnion("kind", [
  LangChainProviderConfigSchema,
  ClaudeProviderConfigSchema,
  CursorProviderConfigSchema,
  CliProviderConfigSchema,
]);

export const ProvidersSchema = z.record(ProviderConfigSchema);

// ---------------------------------------------------------------------------
// Runtime block
// ---------------------------------------------------------------------------

export const CheckpointBackendSchema = z.union([
  z.literal("memory"),
  z.literal("sqlite"),
  z.literal("postgres"),
  z.string(),
]);

export const StoreBackendSchema = z.union([
  z.literal("memory"),
  z.literal("none"),
  z.string(),
]);

export const HitlPolicySchema = z.union([
  z.literal("prompt"),
  z.literal("fail"),
  z.literal("approve"),
  z.literal("webhook"),
]);

export const RuntimeSchema = z.object({
  checkpoint: z
    .object({
      enabled: z.boolean().optional().default(true),
      backend: CheckpointBackendSchema.optional().default("memory"),
      path: z.string().optional(),
      namespace: z.string().optional(),
    })
    .optional(),
  store: z
    .object({
      enabled: z.boolean().optional().default(true),
      backend: StoreBackendSchema.optional().default("memory"),
    })
    .optional(),
  /** Embedded HTTP ingress for `wait` nodes with `webhook: true`. Local/trusted-network only (no auth in v1). */
  webhookServer: z
    .object({
      /** Default 8878. Use 0 for an OS-assigned ephemeral port. */
      port: z.number().int().nonnegative().optional(),
      /** Default 127.0.0.1. */
      host: z.string().optional(),
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
    })
    .optional(),
  hitl: z
    .object({
      onInterrupt: HitlPolicySchema.optional().default("prompt"),
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
  secrets: z
    .object({
      provider: z.union([z.literal("env"), z.literal("dotenv"), z.string()]).optional(),
      redact: z
        .object({
          patterns: z.array(z.string()).optional(),
          headers: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  observability: z
    .object({
      otel: z
        .object({
          enabled: z.boolean().optional(),
          endpoint: z.string().optional(),
        })
        .optional(),
      logs: z
        .object({
          level: z.union([z.literal("debug"), z.literal("info"), z.literal("warn"), z.literal("error")]).optional(),
          format: z.union([z.literal("auto"), z.literal("pretty"), z.literal("json")]).optional(),
        })
        .optional(),
    })
    .optional(),
  hooks: z
    .array(
      z.object({
        on: z.string(),
        where: z.record(z.unknown()).optional(),
        do: z.string(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// Local tools (opt-in filesystem, etc.)
// ---------------------------------------------------------------------------

export const FsOperationSchema = z.enum(["read", "list", "write", "edit", "delete"]);

export const LocalToolsFsSchema = z.object({
  workspaceRoot: z.string().optional().default("."),
  operations: z.array(FsOperationSchema).optional(),
});

export const LocalToolsSchema = z.object({
  fs: LocalToolsFsSchema.optional(),
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
// Root Graph spec
// ---------------------------------------------------------------------------

export const GraphSpecSchema = z.object({
  apiVersion: VersionSchema,
  kind: z.literal("Graph"),
  metadata: MetadataSchema,
  /**
   * Host-interpreted auto-start conditions (cron, startup, flow-complete, …).
   * The engine does not schedule these; desktop/server hosts do.
   */
  triggers: z.array(TriggerSchema).optional(),
  imports: z.array(ImportSpecSchema).optional(),
  mcpServers: z.record(McpServerSchema).optional(),
  localTools: LocalToolsSchema.optional(),
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
  runtime: RuntimeSchema.optional(),
});

export type GraphSpec = Omit<z.infer<typeof GraphSpecSchema>, "nodes"> & {
  nodes: NodeSpec[];
};

/** NodeSpec with optional inline `spec` typed as GraphSpec (recursive). */
export type NodeSpec = Omit<z.infer<typeof NodeSpecSchema>, "spec"> & {
  /** Inline embedded subgraph (see NodeSpecSchema.spec). */
  spec?: GraphSpec;
};

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type LangChainProviderConfig = z.infer<typeof LangChainProviderConfigSchema>;
export type ClaudeProviderConfig = z.infer<typeof ClaudeProviderConfigSchema>;
export type CursorProviderConfig = z.infer<typeof CursorProviderConfigSchema>;
export type CliProviderConfig = z.infer<typeof CliProviderConfigSchema>;
export type CliVendor = z.infer<typeof CliVendorSchema>;
export type LangChainVendor = z.infer<typeof LangChainVendorSchema>;

// ---------------------------------------------------------------------------
// Diagnostic (validation result)
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** dot-path into the spec object, e.g. "nodes[2].with.prompt" */
  path?: string;
}

export function isError(d: Diagnostic): boolean {
  return d.severity === "error";
}
