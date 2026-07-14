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

export const OutputMappingSchema = z.union([
  z.object({ to: z.string() }),
  z.object({ map: z.record(z.string()) }),
]);

// ---------------------------------------------------------------------------
// Node `with` blocks — per-type config
// ---------------------------------------------------------------------------

const BaseWithSchema = z.object({
  output: OutputMappingSchema.optional(),
});

// intelligent node
export const IntelligentWithSchema = BaseWithSchema.extend({
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

// code node
export const CodeWithSchema = BaseWithSchema.extend({
  fn: z.string().describe("Registered function name"),
  input: z.record(z.string()).optional(),
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

// wait node
export const WaitWithSchema = z.object({
  duration: DurationSchema.optional(),
  until: z.string().optional(),
  signal: z.string().optional(),
  timeout: DurationSchema.optional(),
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

// webhook node
export const WebhookWithSchema = BaseWithSchema.extend({
  mode: z.union([z.literal("wait"), z.literal("emit")]).default("wait"),
  timeout: DurationSchema.optional(),
  schema: z.record(z.unknown()).optional(),
  url: z.string().optional(),
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
  description: z.string().optional(),
  // top-level fields for common types
  provider: z.string().optional(),
  model: z.string().optional(),
  uses: z.string().optional().describe("Skill reference (for skill nodes)"),
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

export type NodeSpec = z.infer<typeof NodeSpecSchema>;

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
]);

export const LangChainProviderConfigSchema = z.object({
  kind: z.literal("langchain"),
  vendor: LangChainVendorSchema,
  model: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
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

/** @deprecated Use LangChainProviderConfigSchema */
export const ProviderConfigSchema = z.discriminatedUnion("kind", [
  LangChainProviderConfigSchema,
  ClaudeProviderConfigSchema,
  CursorProviderConfigSchema,
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
// Root Graph spec
// ---------------------------------------------------------------------------

export const GraphSpecSchema = z.object({
  apiVersion: VersionSchema,
  kind: z.literal("Graph"),
  metadata: MetadataSchema,
  imports: z.array(ImportSpecSchema).optional(),
  mcpServers: z.record(McpServerSchema).optional(),
  localTools: LocalToolsSchema.optional(),
  providers: ProvidersSchema.optional(),
  config: ConfigSchema.optional(),
  state: StateSchema.optional(),
  /** Default run input seeded when a run starts (desktop Start inspector / CLI may override). */
  input: z.record(z.unknown()).optional(),
  nodes: z.array(NodeSpecSchema),
  edges: z.array(EdgeSpecSchema),
  runtime: RuntimeSchema.optional(),
});

export type GraphSpec = z.infer<typeof GraphSpecSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type LangChainProviderConfig = z.infer<typeof LangChainProviderConfigSchema>;
export type ClaudeProviderConfig = z.infer<typeof ClaudeProviderConfigSchema>;
export type CursorProviderConfig = z.infer<typeof CursorProviderConfigSchema>;
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
