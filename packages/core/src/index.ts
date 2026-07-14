// Core public API

export { loadGraph, validateSpec } from "./loader.js";
export { loadGraphImports } from "./runtime/load-imports.js";
export type { LoadGraphImportsOptions, LoadGraphImportsResult } from "./runtime/load-imports.js";
export { compileGraph } from "./compiler.js";
export type { GraphSpec, NodeSpec, EdgeSpec } from "@veloxdevworks/flowgraph-spec";
export type {
  CompileOptions,
  RunOptions,
  ResumeOptions,
  ContinueOptions,
  RunResult,
  CompiledGraph,
  InterruptInfo,
  InterruptPolicy,
  StateSnapshot,
} from "./compiler.js";

export { parseDuration, sleep } from "./runtime/duration.js";
export { runWithPolicy, isTimeoutError } from "./runtime/retry.js";
export type { RetryConfig } from "./runtime/retry.js";

export { registry, defineNode } from "./registry.js";
export type { NodeFactory, CompiledNode, NodeResult, NodeContract, NodeCapabilities, ReducerFn } from "./registry.js";
export { registerFunction } from "./nodes/code.js";
export { registerFunction as registerFn } from "./nodes/code.js";

export { createEventBus, consoleSink, jsonlSink } from "./events.js";
export type { FlowgraphEvent, EventType, EventBus, EventSink, EventScope } from "./events.js";

export {
  createEnvSecretProvider,
  createDotenvSecretProvider,
  createRedactor,
  createSecretSetup,
  redactingSink,
  DEFAULT_REDACT_PATTERNS,
} from "./secrets.js";
export type { SecretProvider, Redactor } from "./secrets.js";

export {
  createLogger,
} from "./context.js";
export type { RunContext, NodeRunContext, RunConfig, Logger, InterruptKind } from "./context.js";

export type { McpHub, McpToolInfo, McpToolAnnotations } from "./mcp/types.js";
export { expandMcpTools, requireMcpHub, mcpToolName, parseMcpToolName, isMcpToolRef } from "./mcp/expand.js";
export type { McpToolRef } from "./mcp/expand.js";
export { resolveSkillPath } from "./skill-resolver.js";
export type { SkillAliasMap, SkillResolverOptions } from "./skill-resolver.js";
export { discoverSkillUses } from "./discover-skills.js";
export { preflightGraphSkills } from "./preflight-graph.js";
export type { PreflightGraphOptions, PreflightGraphResult } from "./preflight-graph.js";

// Hooks — lifecycle interception (mutate/veto/route/retry/interrupt)
export { createHookBus } from "./hooks/bus.js";
export type { HookBus, HookRunResult } from "./hooks/bus.js";
export { hooksFromSpec, defaultGuardrailHooks } from "./hooks/builtin.js";
export type {
  Hook,
  HookPhase,
  HookContext,
  HookResult,
  HookDirective,
  HookPayload,
  HookWhere,
} from "./hooks/types.js";

// Provider abstraction for intelligent nodes
export {
  defineProvider,
  registerProvider,
  getProvider,
  hasProvider,
  listProviders,
  registerTool,
  getTool,
  mockProvider,
  createScriptedProvider,
  normalizeTools,
  mergeTools,
  checkToolCall,
  reportToolResult,
  requireToolApproval,
} from "./providers/index.js";
export type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderRunContext,
  AgentRequest,
  AgentResult,
  AgentEvent,
  AgentStep,
  ToolSpec,
  ToolKind,
  Message,
  TokenUsage,
  ToolFunctionDef,
  ToolRef,
  ToolWiring,
  ToolExecutor,
  GovernanceCtx,
} from "./providers/index.js";
export type { BudgetState } from "./context.js";

// Built-in LangChain provider (intelligent nodes)
export {
  createLangChainProvider,
  createLangChainProviderFromConfig,
  isKnownLangChainVendor,
  LANGCHAIN_VENDORS,
} from "./providers/langchain/index.js";
export type {
  ChatModelLike,
  LangChainProviderOptions,
  LangChainProviderConfigInput,
  LangChainProviderFromConfigOptions,
} from "./providers/langchain/index.js";

// Built-in node exports
export { routerNode, httpNode, codeNode, waitNode, skillNode, intelligentNode, subgraphNode, mapNode, mcpNode, hitlNode, webhookNode } from "./nodes/index.js";
