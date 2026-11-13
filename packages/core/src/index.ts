// Core public API

export {
  loadGraph,
  validateSpec,
  normalizeNodeTypeAliases,
  envExpansionCollisionDiagnostics,
  NODE_BODY_ENV_EXPANSION,
} from "./loader.js";
export { loadGraphImports } from "./runtime/load-imports.js";
export type { LoadGraphImportsOptions, LoadGraphImportsResult } from "./runtime/load-imports.js";
export {
  collectNodeWriteChannels,
  ensureDeclaredOutputChannels,
  undeclaredOutputChannelDiagnostics,
  unconditionalFanOutDiagnostics,
  hitlRouteDiagnostics,
  hitlSelectDiagnostics,
  hitlRouterMergeDiagnostics,
} from "./runtime/validate-graph.js";
export {
  hitlOutcomes,
  hitlOutcomeKey,
  hitlRouteTargets,
  normalizeHitlRoutes,
  resolveHitlRoute,
  HITL_DEFAULT_ROUTE,
} from "./nodes/hitl-routes.js";
export type { HitlRoute, HitlOutcomes } from "./nodes/hitl-routes.js";
export { applyOutput, isOutputNone, OUTPUTS_CHANNEL } from "./runtime/apply-output.js";
export {
  resolveAndValidateInput,
  isInputValidationError,
  InputValidationError,
} from "./inputs.js";
export { compileGraph, resolveGraphWorkspace, ResumeAttemptsExhaustedError, assertResumeValue } from "./compiler.js";
export {
  NODE_POLICY,
  NodePolicyError,
  assertNodeTypeAllowed,
  assertSubgraphFileAllowed,
  assertSecretAllowed,
  assertToolAllowed,
  assertFunctionAllowed,
  assertHostExecAllowed,
  assertNodeSpecAllowed,
  assertGraphRuntimeAllowed,
  assertNoReservedChannels,
  assertNoReservedInput,
  withoutReservedKeys,
  assertAgentRefAllowed,
  assertImportsAllowed,
  assertInboundWebhookAllowed,
  isReservedChannel,
  reservedStateMapRefs,
  reservedInputRefs,
  reservedTemplateRefs,
  templateRefs,
  RESERVED_CHANNEL_PREFIX,
  hostExecAllowed,
  registeredToolNamesOf,
  BUILTIN_TOOL_TARGETS,
  nodePolicyOf,
  type NodePolicy,
  type NodePolicyErrorCode,
  type TemplateRefs,
} from "./node-policy.js";
export {
  classifyAddress,
  DEFAULT_OUTBOUND_MAX_RESPONSE_BYTES,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  guardedFetch,
  hostIsAllowListed,
  type AddressVerdict,
  type GuardedFetchInit,
  type OutboundHttpPolicy,
  type OutboundResolver,
} from "./outbound-http.js";
export type { MemoryHostOptions } from "./compiler.js";
export { FlowgraphMemorySaver, type FlowgraphMemorySaverOptions } from "./checkpoint/memory-saver.js";
export {
  CHECKPOINT_INLINE_MAX_BYTES,
  CHECKPOINT_PIN_CHANNELS,
  CHECKPOINT_PRUNED,
  THREAD_MOVED_ON,
  THREAD_WAIT_NOT_RECORDED,
  type ThreadWaitErrorCode,
  DEFAULT_ACTIVE_TTL_MS,
  DEFAULT_CHECKPOINT_RETENTION,
  ThreadRunGuard,
  abandonedActivePolicy,
  abandonedFallbackCutoff,
  checkpointPrunedError,
  isRetentionSaver,
  resolveCheckpointRetention,
  retentionDurationMs,
  retentionStatusForRun,
  selectRetainedCheckpointIds,
  threadDeletionRequested,
} from "./checkpoint/retention.js";
export type {
  ActiveRowPolicy,
  ActiveThreadMark,
  CheckpointRetentionInput,
  CheckpointRetentionSaver,
  CheckpointThreadStatus,
  SavedThreadStatus,
  CheckpointVacuum,
  ResolvedCheckpointRetention,
} from "./checkpoint/retention.js";
export * from "./memory/index.js";
export { memoryNode } from "./nodes/memory.js";
export {
  DEFAULT_MAX_RESUME_ATTEMPTS,
  interruptUntilValid,
  resumeValidationInfo,
} from "./runtime/resume-validation.js";
export type { ResumeValidationInfo } from "./runtime/resume-validation.js";
export type { GraphSpec, NodeSpec, EdgeSpec, InputField, InputFieldType } from "@flowgraph/spec";
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

export {
  ONCE_CHANNEL,
  REPLAY_CHANNEL,
  MAP_COLLECT_CHANNEL,
  MAP_TASK_CHANNEL,
  SERVICES_CHANNEL,
  WORKTREES_CHANNEL,
  ISSUES_CHANNEL,
  RESERVED_STATE_CHANNELS,
} from "./runtime/state-annotation.js";
export { ReplayMismatchError, ReplayStore, replayNodeKey, runScopeOf, type RunScope } from "./providers/replay-cache.js";
export { parseDuration, sleep } from "./runtime/duration.js";
export { runWithPolicy, isTimeoutError } from "./runtime/retry.js";
export type { RetryConfig } from "./runtime/retry.js";
export {
  ensureWebhookServer,
  closeWebhookServers,
  closeWebhookServer,
  waitForWebhookResume,
  buildWebhookUrl,
  getWebhookRoute,
  validateWebhookServerConfig,
  DEFAULT_WEBHOOK_HOST,
  DEFAULT_WEBHOOK_PORT,
} from "./runtime/webhook-server.js";
export type {
  WebhookIngressConfig,
  WebhookServerConfig,
  WebhookServerInfo,
  WebhookRoute,
  WebhookResumeFn,
} from "./runtime/webhook-server.js";

export {
  startService,
  stopService,
  restartService,
  statusService,
  terminateThreadServices,
  resetServiceManager,
  listThreadServices,
  threadIdOf,
} from "./runtime/service-manager.js";
export type {
  ServiceReady,
  ServiceStartSpec,
  ServiceInfo,
  ServiceStatusValue,
} from "./runtime/service-manager.js";

export { findFreePorts } from "./runtime/port.js";
export type { FindFreePortsOptions } from "./runtime/port.js";

export { registry, defineNode, describeNodeTypes } from "./registry.js";
export type { NodeFactory, CompiledNode, NodeResult, NodeContract, NodeCapabilities, ReducerFn, NodeUiMeta, NodeTypeDescriptor } from "./registry.js";
export { registerFunction } from "./nodes/function.js";
export { registerFunction as registerFn } from "./nodes/function.js";
export { runScriptSandboxed } from "./nodes/script.js";
export type {
  RunScriptSandboxedOptions,
  RunScriptSandboxedResult,
  ScriptPermissions,
} from "./nodes/script.js";

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
export { discoverSkillUses, discoverSubgraphFileUses, walkNodes } from "./discover-skills.js";
export { resolveAgentPath } from "./agent-resolver.js";
export type { AgentAliasMap, AgentResolverOptions } from "./agent-resolver.js";
export { discoverAgentUses } from "./discover-agents.js";
export { loadAgentDef } from "./agents/loader.js";
export type { AgentDef, AgentFrontMatter } from "./agents/schema.js";
export { AgentFrontMatterSchema } from "./agents/schema.js";
export { preflightGraphSkills, preflightGraphAgents, preflightGraphRequires } from "./preflight-graph.js";
export type { PreflightGraphOptions, PreflightGraphResult } from "./preflight-graph.js";
export { bundleGraphForRemote } from "./runtime/bundle-graph.js";
export type { BundleResult, BundleGraphOptions } from "./runtime/bundle-graph.js";

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

// Provider abstraction for agent nodes
export {
  defineProvider,
  registerProvider,
  getProvider,
  hasProvider,
  listProviders,
  providerFor,
  providerNamesFor,
  graphProviderList,
  GRAPH_PROVIDERS,
  registerTool,
  getTool,
  mockProvider,
  createScriptedProvider,
  createCliProvider,
  detectLocalCli,
  defaultBinaryFor,
  cliVendorForProviderKind,
  apiKeyEnvForProviderKind,
  hasApiKey,
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
  GraphProviders,
  ToolRef,
  ToolWiring,
  ToolExecutor,
  GovernanceCtx,
  CliVendor,
  CliProviderOptions,
} from "./providers/index.js";
export type { BudgetState } from "./context.js";

// Built-in LangChain provider (agent nodes)
export {
  createLangChainProvider,
  createLangChainProviderFromConfig,
  createLangChainChatModelFromConfig,
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
export {
  routerNode,
  httpNode,
  functionNode,
  codeNode,
  shellNode,
  serviceNode,
  portNode,
  scriptNode,
  waitNode,
  skillNode,
  agentNode,
  intelligentNode,
  subgraphNode,
  mapNode,
  mcpNode,
  hitlNode,
  workshopNode,
  webhookNode,
  demoNode,
  worktreeNode,
} from "./nodes/index.js";

export {
  demoManifestPath,
  appendDemoManifestEntry,
  readDemoManifest,
  demoManifestKey,
} from "./nodes/demo-manifest.js";
export type { DemoManifestEntry, DemoKind, DemoExtraArtifact } from "./nodes/demo-manifest.js";
export type { DemoResult } from "./nodes/demo.js";
export type { RunIssue, RunIssueSeverity, IssueInput } from "./runtime/run-issues.js";
export {
  appendRunIssue,
  readRunIssues,
  runIssuesPath,
  runIssuesKey,
  ISSUE_CODE,
  ISSUES_CHANNEL_CAP,
} from "./runtime/run-issues.js";
export { checkBinOnPath, isMissingBinaryError, toolNotFoundMessage } from "./runtime/which.js";

// Context budgets for agent nodes (with.context / runtime.context)
export {
  registerTokenEstimator,
  getTokenEstimator,
  hasTokenEstimator,
  bytesEstimator,
  messageTokens,
  ContextWindow,
  ContextOverflowError,
  resolveContextPolicy,
  extractiveSummarizer,
  capToolResult,
  toUnits,
  fromStoredMessage,
  toLangChainMessage,
  summaryMessageId,
  CONTEXT_DEFAULT_MAX_TOKENS,
} from "./context/index.js";
export type {
  TokenEstimator,
  ContextPolicy,
  ContextConfigInput,
  ContextStats,
  ContextStrategy,
  ContextMessage,
  FittedContext,
  ProviderContextManager,
  Summarizer,
  SummarizeRequest,
} from "./context/index.js";
export { isNonRetryable } from "./runtime/retry.js";

// ── Generative media (image / video / model3d) — ADR-0017 ──────────────────
export {
  registerMediaVendor,
  registerMediaProvider,
  getMediaVendor,
  listMediaVendors,
  deriveMediaProviders,
  mediaProviderFor,
  mediaProvidersFor,
  GRAPH_MEDIA_PROVIDERS,
} from "./media/registry.js";
export { runMediaJob } from "./media/run-job.js";
export { createFileJournal, fingerprintRequest } from "./media/journal.js";
export { createOutputWriter, describeArtifactFile, artifactDir, extensionForMime, mimeForExtension, probeImageSize } from "./media/artifacts.js";
export { resolveMediaInputs } from "./media/inputs.js";
export { imageNode, videoNode, model3dNode, audioNode } from "./nodes/media.js";
export type {
  MediaModality,
  MediaInput,
  MediaRequest,
  MediaOutput,
  MediaCallContext,
  MediaProvider,
  MediaVendor,
  MediaVendorOptions,
  JobHandle,
  JobStatus,
  JobState,
} from "./media/types.js";

// Node placement (ADR-0020)
export * from "./placement/index.js";
export { CORE_VERSION } from "./version.js";
export { CORE_BUILTIN_NODE_TYPES } from "./nodes/index.js";
