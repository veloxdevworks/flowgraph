/**
 * Stage 2: build a LangGraph StateGraph from a validated GraphSpec,
 * plus run/resume/inspect with durability, HITL, and retry/timeout.
 */

import { START, END, StateGraph, Command, Send, type BaseCheckpointSaver, type BaseStore, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { interrupt as lgInterrupt } from "@langchain/langgraph";
import { resumeValidationInfo } from "./runtime/resume-validation.js";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createExecutionLimit, type ExecutionLimit } from "./runtime/concurrency.js";
import type { GraphSpec, NodeSpec, OutputMapping } from "@flowgraph/spec";
import { applyOutput } from "./runtime/apply-output.js";
import { walkNodes } from "./discover-skills.js";
import { MapWithSchema } from "@flowgraph/spec";
import { evalGuard, renderDeep } from "@flowgraph/expr";
import { registry, type NodeFactory } from "./registry.js";
import { createEventBus, withEventThread, type EventBus, type EventSink, type FlowgraphEvent } from "./events.js";
import { createEnvSecretProvider } from "./secrets.js";
import {
  createLogger,
  type RunContext,
  type NodeRunContext,
  type RunConfig,
  type RunMeta,
} from "./context.js";
import type { NodeResult } from "./registry.js";
import { buildStateAnnotation, ONCE_CHANNEL, MAP_COLLECT_CHANNEL, MAP_TASK_CHANNEL, SERVICES_CHANNEL, WORKTREES_CHANNEL, ISSUES_CHANNEL, RESERVED_STATE_CHANNELS } from "./runtime/state-annotation.js";
import { FlowgraphMemorySaver } from "./checkpoint/memory-saver.js";
import {
  checkpointPrunedError,
  THREAD_MOVED_ON,
  THREAD_WAIT_NOT_RECORDED,
  threadWaitError,
  isRetentionSaver,
  resolveCheckpointRetention,
  retentionStatusForRun,
  type CheckpointRetentionInput,
} from "./checkpoint/retention.js";
import {
  appendRunIssue,
  issueDedupeKey,
  readRunIssues,
  runIssuesKey,
  stampIssue,
  type IssueInput,
  type RunIssue,
} from "./runtime/run-issues.js";
import { OUTPUTS_CHANNEL } from "./runtime/apply-output.js";
import {
  collectNodeWriteChannels,
  demoToolExposureDiagnostics,
  ensureDeclaredOutputChannels,
  provesObjective,
} from "./runtime/validate-graph.js";
import { warnFanInLastWrite } from "./runtime/fan-in-warning.js";
import { sharedHistoryChannels } from "./context/shared.js";
import { loadGraphImports } from "./runtime/load-imports.js";
import { graphFile } from "./runtime/graph-files.js";
import { nodeRouteTargets, nodeToolTargets, topologyDiagnostics } from "./runtime/validate-graph.js";
import { runWithPolicy, type RetryConfig as RetryConfigInput } from "./runtime/retry.js";

/**
 * How long a node that stops on timeout gets to do so before the run moves on. A capture gives
 * a recorder 15 seconds to finish, and a device a few more to clean up.
 */
const TIMED_OUT_ATTEMPT_STOP_MS = 20_000;
import {
  ensureWebhookServer,
  registerWebhookRoute,
  unregisterWebhookRoute,
  buildWebhookUrl,
  getWebhookRoute,
  type WebhookServerConfig,
} from "./runtime/webhook-server.js";
import { terminateThreadServices, startService, statusService, type ServiceStartSpec } from "./runtime/service-manager.js";
import { cleanupWorktrees } from "./nodes/worktree.js";
import { registerProvider, type ProviderAdapter } from "./providers/index.js";
import { GRAPH_PROVIDERS, type GraphProviders } from "./providers/registry.js";
import { GRAPH_MEDIA_PROVIDERS, deriveMediaProviders, type GraphMediaProviders } from "./media/registry.js";
import type { MediaProvider } from "./media/types.js";
import { ReplayStore, RUN_SCOPE_KEY, replayNodeKey, replayStoreFromInterrupts, runScopeOf, runSignalOf, type RunScope } from "./providers/replay-cache.js";
import { collectMapResults, mapSyntheticIds, runMapItem, type MapTask } from "./nodes/map.js";
import type { ToolWiring } from "./providers/tools.js";
import type { BudgetState } from "./context.js";
import type { McpHub } from "./mcp/types.js";
import { createHookBus, type HookBus } from "./hooks/bus.js";
import type { Hook } from "./hooks/types.js";
import { hooksFromSpec, defaultGuardrailHooks } from "./hooks/builtin.js";
import "./nodes/index.js";
import { planPlacements, type CompilePlacementOptions, type PlacementPlan } from "./placement/plan.js";
import type { PlacementInfo, RemoteNodeExecutor } from "./placement/remote.js";
import { wrapperSpecForNode } from "./placement/remote.js";
import { hitlRouteTargets } from "./nodes/hitl-routes.js";
import { acquireThreadRun, threadAdmissionError, type ThreadRunClaim } from "./checkpoint/execution-claim.js";
import { exclusiveRouting, normalTargets, recoveryTargets, ROUTING_CHANNEL } from "./runtime/routing-policy.js";

import { finishInterruptDeadline, preserveInterruptDeadline, seedInterruptDeadlines, interruptFingerprint } from "./runtime/interrupt-lifecycle.js";
import { MemoryRuntime, MEMORY_RUNTIME, createEphemeralMemoryRuntime, LOCAL_MEMORY_IDENTITY, type RuntimeMemoryConfig } from "./memory/runtime.js";
import { MemoryError, type MemoryBackend, type MemoryIdentity } from "./memory/types.js";
import {
  NODE_POLICY,
  assertGraphRuntimeAllowed,
  assertGraphToolsAllowed,
  assertHostExecAllowed,
  assertHostProbeAllowed,
  assertNoReservedChannels,
  assertImportsAllowed,
  isReservedChannel,
  withoutReservedKeys,
  assertNoReservedInput,
  hostExecAllowed,
  assertNodeSpecAllowed,
  assertNodeTypeAllowed,
  type NodePolicy,
} from "./node-policy.js";

export type InterruptPolicy = "prompt" | "fail" | "approve" | "webhook";

export interface CompileOptions {
  cwd?: string;
  /** Explicit execution workspace; graph references still resolve against graphPath/source. */
  workspace?: string;
  /** Graph file path — `imports` specifiers resolve relative to this file's directory. */
  graphPath?: string;
  sinks?: EventSink[];
  runConfig?: RunConfig;
  checkpointer?: "memory" | "none" | BaseCheckpointSaver;
  /**
   * Retention for the in-memory checkpointer this compile creates. Host
   * fields override `runtime.checkpoint.retention`. Ignored when `checkpointer`
   * is an instance — that saver already has its own policy. `false` keeps
   * every checkpoint.
   */
  checkpointRetention?: boolean | CheckpointRetentionInput | null;
  /**
   * Legacy `ctx.store`. A BaseStore instance is used as-is and is NOT scoped
   * (every graph sharing it sees every key). "none" disables ctx.store; the
   * default is a graph-scoped adapter over the memory backend.
   */
  store?: "memory" | "none" | BaseStore;
  /**
   * Scoped memory backend. Hosts with a durable checkpointer pass
   * `{ backend, identity }` (the CLI does this for sqlite). "ephemeral" allows
   * an in-process backend for runtime.memory (tests). Subgraphs receive the
   * parent's MemoryRuntime.
   */
  memory?: MemoryHostOptions | MemoryBackend | MemoryRuntime | "ephemeral";
  /**
   * Backend for the graph-scoped `ctx.store` of graphs that do not declare
   * runtime.memory. Long-lived hosts (the server) pass one shared backend so
   * `ctx.store` survives recompiles between a run and its resume while each
   * graph still sees only its own keys. Does not enable `ctx.memory`.
   */
  legacyStoreBackend?: MemoryBackend;
  /**
   * Identity for memory runtimes this compile builds without a host identity:
   * the `legacyStoreBackend` runtime and in-process ones. A multi-user host
   * passes the caller's org/project so graphs with the same name in different
   * orgs never share `ctx.store` keys. Default: { org: "local", project: "local" }.
   */
  memoryIdentity?: MemoryIdentity;
  /**
   * Limits on what this graph may run (blocked node types, file subgraphs,
   * host secrets). Checked as nodes are built, including map inners, agent
   * skill tools and embedded subgraphs at run time. Unset: no limits.
   */
  nodePolicy?: NodePolicy;
  /**
   * How to get durable memory on this host, shown in the
   * MEMORY_BACKEND_UNAVAILABLE error instead of the CLI/library advice when a
   * graph needs memory and no backend was passed (the server points at its
   * FLOWGRAPH_MEMORY_BACKEND setting).
   */
  memoryUnavailableHint?: string;
  /**
   * Node placement (ADR-0020). Without `topology` and `transport`, a placed top-level node must be
   * satisfiable by this host (or set `fallback: local`), else compile throws `PlacementUnsatisfiedError`.
   * With them, nodes the local host cannot run are dispatched to a matching worker.
   */
  placement?: CompilePlacementOptions;
  extraFactories?: NodeFactory[];
  providers?: ProviderAdapter[];
  /**
   * Media providers (image/video/model3d) this graph may use, in addition to
   * those derived from its `providers:` block.
   */
  mediaProviders?: MediaProvider[];
  interruptBefore?: string[];
  interruptAfter?: string[];
  /** Programmatic hooks registered in addition to YAML-bound + default hooks. */
  hooks?: Hook[];
  /** MCP hub for mcp nodes and intelligent MCP tools (built from mcpServers by CLI). */
  mcp?: McpHub;
  /**
   * Called with the result of a background resume fired by a `wait` timeout
   * (onInterrupt "fail"/"webhook" runs). Errors are also emitted as `run.error`.
   */
  onWaitTimeout?: (result: RunResult) => void;
  /** Clock used for wait-deadline timers. Tests inject this so a deadline can fire without waiting. */
  now?: () => number;
  /** Timer scheduler for wait deadlines. Tests inject this instead of mocking global setTimeout. */
  scheduleTimeout?: (fn: () => void, delayMs: number) => unknown;
}

export interface InterruptInfo {
  id: string;
  reason?: string;
  payload?: unknown;
  /** How the interrupt should be answered (approval, free-text question, choice list). */
  kind?: import("./context.js").InterruptKind;
  choices?: string[];
  /** ISO timestamp when a wait node's timeout elapses. */
  deadlineAt?: string;
  /** Set when this is a re-prompt after a rejected answer (hitl / workshop). */
  validationError?: string;
  /** Rejected answers so far (with `validationError`). */
  attempt?: number;
  maxAttempts?: number;
  /** Re-prompt budget spent; the run reported an error but the interrupt is still resumable. */
  exhausted?: boolean;
}

/** Run error when a hitl/workshop node rejected `maxResumeAttempts` answers. */
export class ResumeAttemptsExhaustedError extends Error {
  readonly code = "RESUME_ATTEMPTS_EXHAUSTED";
  constructor(message: string) {
    super(message);
    this.name = "ResumeAttemptsExhaustedError";
  }
}

function describeExhausted(it: InterruptInfo): string {
  const nodeId = (it.payload as { data?: { __nodeId?: string } } | undefined)?.data?.__nodeId ?? it.id;
  return (
    `node "${nodeId}" rejected ${it.attempt ?? "?"} of ${it.maxAttempts ?? "?"} allowed resume answers ` +
    `(last error: ${it.validationError ?? "unknown"}). The interrupt is still pending; ` +
    `resume the thread again with a valid answer.`
  );
}

export interface RunOptions {
  input?: Record<string, unknown>;
  threadId?: string;
  signal?: AbortSignal;
  /**
   * Graceful pause: stop before the next node of the top-level graph starts
   * and return `status: "paused"` so the thread can later be resumed via
   * `continueRun`. Nodes already running finish first, with everything they
   * run: the nodes of an embedded subgraph, the items of a map, and nodes
   * or subgraphs an agent calls as tools. Distinct from `signal`, which
   * hard-cancels (not resumable).
   */
  pauseSignal?: AbortSignal;
  sinks?: EventSink[];
  onInterrupt?: InterruptPolicy;
  /** Resolver used when onInterrupt is "prompt"/"approve". Returns the resume value. */
  resolveInterrupt?: (interrupts: InterruptInfo[]) => Promise<unknown> | unknown;
}

export interface ResumeOptions {
  threadId: string;
  resume: unknown;
  signal?: AbortSignal;
  pauseSignal?: AbortSignal;
  sinks?: EventSink[];
  onInterrupt?: InterruptPolicy;
  resolveInterrupt?: (interrupts: InterruptInfo[]) => Promise<unknown> | unknown;
  /** Time-travel: start this resume from a historical checkpoint id. */
  checkpointId?: string;
}

/** Continue a paused (or checkpointed) thread from its next nodes — not HITL resume. */
export interface ContinueOptions {
  threadId: string;
  signal?: AbortSignal;
  pauseSignal?: AbortSignal;
  sinks?: EventSink[];
  onInterrupt?: InterruptPolicy;
  resolveInterrupt?: (interrupts: InterruptInfo[]) => Promise<unknown> | unknown;
}

export interface RunResult {
  status: "completed" | "interrupted" | "paused" | "error" | "aborted";
  state: Record<string, unknown>;
  runId: string;
  threadId?: string | undefined;
  interrupts?: InterruptInfo[] | undefined;
  error?: Error | undefined;
  durationMs: number;
  /** Non-fatal degradations recorded during the run (from the issues log). */
  issues?: RunIssue[] | undefined;
}

export interface StateSnapshot {
  values: Record<string, unknown>;
  next: string[];
  checkpointId?: string | undefined;
  interrupts: InterruptInfo[];
  createdAt?: string | undefined;
}

export interface CompiledGraph {
  spec: GraphSpec;
  runId: string;
  events: EventBus;
  run(opts?: RunOptions): Promise<RunResult>;
  resume(opts: ResumeOptions): Promise<RunResult>;
  /** Resume a paused/checkpointed thread from `next` (not HITL). */
  continueRun(opts: ContinueOptions): Promise<RunResult>;
  getState(threadId: string, opts?: { applyWaitTimeouts?: boolean }): Promise<StateSnapshot | null>;
  getStateHistory(threadId: string): Promise<StateSnapshot[]>;
  /** Continue from a historical checkpoint id (thin wrapper on getStateHistory). */
  resumeFrom(opts: ResumeOptions & { checkpointId: string }): Promise<RunResult>;
  /**
   * Run exactly one superstep of a paused/checkpointed thread, then stop with
   * `status: "paused"` (or `completed` / `interrupted` if that step finished
   * the graph or raised a HITL interrupt). Requires a checkpointer.
   */
  step(opts: ContinueOptions): Promise<RunResult>;
  stream(opts?: RunOptions): AsyncIterable<FlowgraphEvent>;
  /** Where each `runsOn` node was placed at compile time (ADR-0020). Empty when the graph has none. */
  placements: import("./placement/resolve.js").PlacementDecision[];
}

type ExecuteMode = "start" | "resume" | "continue";

/** Per-invocation execution options (never written back to the shared spec). */
interface InvokeOverrides {
  threadClaim?: ThreadRunClaim;
  backgroundWaitTimeout?: boolean;
  /** Stop after one superstep (LangGraph invoke-time `interruptAfter: "*"`). */
  singleStep?: boolean;
  /** An HTTP callback targets one interrupt; leave sibling route registrations intact. */
  preserveWebhookRoutes?: boolean;
}

/** Raw LangGraph compiled graph for embedding inside a parent subgraph node. */
export interface EmbeddedCompiledGraph {
  compiledLg: ReturnType<StateGraph<unknown>["compile"]>;
}

export async function compileGraphForEmbedding(
  spec: GraphSpec,
  opts: CompileOptions = {},
): Promise<EmbeddedCompiledGraph> {
  const { compiledLg } = await assembleCompiledLangGraph(spec, {
    ...opts,
    checkpointer: "none",
    // Preserve caller sinks (e.g. parent-bus forwarding from the subgraph node).
    // Do not force sinks: [] — nested events would otherwise be invisible.
  });
  return { compiledLg };
}

interface AssembledGraph {
  spec: GraphSpec;
  runId: string;
  events: EventBus;
  compiledLg: ReturnType<StateGraph<unknown>["compile"]>;
  checkpointer: BaseCheckpointSaver | undefined;
  hooks: HookBus;
  baseCtx: Partial<RunContext>;
  graphDir: string;
  interruptBefore: string[];
  interruptAfter: string[];
  defaultPolicy: InterruptPolicy;
}

export async function compileGraph(spec: GraphSpec, opts: CompileOptions = {}): Promise<CompiledGraph> {
  const plan = await planPlacements(spec, opts.placement);
  const assembled = await assembleCompiledLangGraph(spec, opts, plan);
  const {
    spec: graphSpec,
    runId,
    events,
    compiledLg,
    checkpointer,
    hooks,
    baseCtx,
    interruptBefore,
    interruptAfter,
    defaultPolicy,
  } = assembled;

  const authoredMapNames = new Map<string, string>();
  for (const node of graphSpec.nodes) {
    if (node.type !== "map") continue;
    const { workerId, joinId } = mapSyntheticIds(node.id);
    authoredMapNames.set(workerId, node.id);
    authoredMapNames.set(joinId, node.id);
  }
  const publicNodeId = (id: string): string => authoredMapNames.get(id) ?? id;

  // Per compiled graph: two graphs that reuse a thread id must not cancel each other's timers.
  const waitTimers: WaitTimerMap = new Map();
  const clock = () => (opts.now ?? Date.now)();
  const scheduleTimeout = opts.scheduleTimeout ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));

  const getCheckpointState = async (config: LangGraphRunnableConfig) => {
    const snap = await compiledLg.getState(config);
    if (!checkpointer || !snap.tasks.some((task) => task.interrupts.length > 0)) return snap;
    const saved = await checkpointer.getTuple(snap.config);
    // LangGraph can retain old interrupt writes after a task finishes in a
    // partially answered superstep. Real channel/result writes mark it done;
    // resume writes alone do not (a re-prompt can still be pending).
    const completed = new Set((saved?.pendingWrites ?? []).filter(([, channel]) =>
      Object.prototype.hasOwnProperty.call(snap.values, channel) ||
      channel === "__no_writes__" || channel === "__return__" || channel.startsWith("branch:to:"),
    ).map(([taskId]) => taskId));
    return { ...snap, tasks: snap.tasks.map((task) => completed.has(task.id) ? { ...task, interrupts: [] } : task) };
  };

  const invokeOwned = async (
    payload: Record<string, unknown> | Command | null,
    runOpts: RunOptions | ResumeOptions | ContinueOptions,
    mode: ExecuteMode,
    overrides: InvokeOverrides = {},
  ): Promise<RunResult> => {
    const startMs = Date.now();
    const threadId = runOpts.threadId ?? `thread-${runId}`;
    const graphRetention = graphSpec.runtime?.checkpoint?.retention;
    if (
      checkpointer &&
      isRetentionSaver(checkpointer) &&
      (graphRetention !== undefined || opts.checkpointRetention !== undefined)
    ) {
      checkpointer.noteThreadPolicy?.(
        threadId,
        resolveCheckpointRetention(graphRetention, opts.checkpointRetention),
      );
    }
    clearWaitTimeoutTimer(waitTimers, threadId);
    const startedAt = new Date().toISOString();
    const runMeta: RunMeta = { runId, graph: graphSpec.metadata.name, startedAt, threadId };

    (baseCtx as RunContext).meta = runMeta;
    (baseCtx as RunContext).logger = createLogger(events, graphSpec.metadata.name);
    if (runOpts.signal !== undefined) (baseCtx as RunContext).signal = runOpts.signal;
    // Per-run pause flag checked at the start of each node (see node handler below).
    const pauseable = baseCtx as RunContext & { pauseSignal?: AbortSignal };
    if (runOpts.pauseSignal !== undefined) pauseable.pauseSignal = runOpts.pauseSignal;
    else delete pauseable.pauseSignal;

    const unsubs = (runOpts.sinks ?? []).map((s) => events.subscribe(s));
    const policy = runOpts.onInterrupt ?? defaultPolicy;
    const cfg = buildInvokeConfig(threadId, graphSpec, (runOpts as ResumeOptions).checkpointId);
    if (overrides.singleStep) cfg["interruptAfter"] = "*";
    const workspace = (baseCtx as RunContext).workspace;
    const retention = checkpointer && isRetentionSaver(checkpointer) ? checkpointer : undefined;
    let retentionOpen = false;
    let runToken = 0;
    let answeredResumeIds: string[] = [];
    const resumedRun = () => mode === "resume" || mode === "continue";
    const finish = async (r: RunResult, bookkeeping = true, resumed?: boolean): Promise<RunResult> => {
      try {
        const issues = readRunIssues(workspace, runIssuesKey({ threadId, runId }));
        if (issues.length > 0) r.issues = issues;
      } catch {
        /* ignore unreadable issue logs */
      }
      if (retentionOpen) {
        retentionOpen = false;
        try {
          if (bookkeeping) {
            retention?.endThreadRun?.(threadId, retentionStatusForRun(r.status), runToken, resumed ?? resumedRun());
          } else {
            // This run never started. Drop its token and do not park it.
            retention?.endThreadRun?.(threadId, "active", runToken, false, true);
          }
        } catch {
          /* bookkeeping must not hide the run result */
        }
      }
      if (retention && bookkeeping) {
        try {
          await retention.noteThreadStatus(threadId, retentionStatusForRun(r.status));
        } catch (err) {
          // Retention bookkeeping must not fail a run that already finished.
          if ((r.error as { code?: unknown } | undefined)?.code === THREAD_WAIT_NOT_RECORDED) Object.assign(r.error!, { parkError: err });
        }
      }
      return r;
    };

    // Reserved channels are the engine's own bookkeeping; callers never set them.
    if (mode === "start" && payload != null && !(payload instanceof Command)) {
      assertNoReservedInput(payload, `graph "${graphSpec.metadata.name}" run`);
    }

    // Hold the thread and mark it active before any read, so a sweep in the
    // window before the first checkpoint write cannot delete it. If the run
    // stops before it starts, put the saved status back and drop the token.
    let enteredRun = false;
    let priorRead = false;
    let priorStatus: { status: "active" | "paused" | "finished"; updatedAt: number } | undefined;
    let activeMark: string | undefined;
    let markedAt: number | undefined;
    // While this run waits in-process for an answer it writes nothing, so its
    // row would look abandoned to a sweep on another host. Store it as paused
    // for the wait and set it back to active under the same mark afterwards.
    // If either write fails, or the row is no longer this run's, stop the run
    // instead of waiting unprotected or applying the answer to a thread that
    // moved on.
    const awaitAnswer = async <T>(wait: () => Promise<T> | T): Promise<T> => {
      const mark = activeMark;
      if (!mark || !retention?.noteThreadWaiting) return await wait();
      let waiting: boolean;
      try {
        waiting = await retention.noteThreadWaiting(threadId, mark);
      } catch (err) {
        throw threadWaitError(THREAD_WAIT_NOT_RECORDED, threadId, "before", err);
      }
      if (!waiting) throw threadWaitError(THREAD_MOVED_ON, threadId, "before");
      let answer: T;
      try {
        answer = await wait();
      } catch (err) {
        try {
          await retention.noteThreadAnswered?.(threadId, mark);
        } catch {
          // The row stays paused; the answer's own error is the one to report.
        }
        throw err;
      }
      let answered = true;
      try {
        answered = (await retention.noteThreadAnswered?.(threadId, mark)) ?? true;
      } catch (err) {
        throw threadWaitError(THREAD_WAIT_NOT_RECORDED, threadId, "after", err);
      }
      if (!answered) throw threadWaitError(THREAD_MOVED_ON, threadId, "after");
      return answer;
    };
    try {
      runToken = retention?.beginThreadRun?.(threadId) ?? 0;
      retentionOpen = !!retention;
      try {
        const marked = await retention?.markThreadActive?.(threadId);
        if (marked && typeof marked.mark === "string") {
          activeMark = marked.mark;
          markedAt = marked.markedAt;
          priorStatus = marked.prior;
          // An already-active row belongs to another run. Leave it alone.
          priorRead = marked.prior?.status !== "active";
        }
      } catch {
        // A missed active mark must not fail the run. The in-process hold still applies.
      }

    // Agent replay entries belong to this execution only. A fresh start begins
    // empty; resume/continue load the snapshots the engine attached to this
    // thread's pending interrupts. Nodes (and embedded subgraphs) reach the
    // store through the invoke config, never through a process-wide cache.
    let replay = new ReplayStore();
    let pendingResumeInterrupts: Array<{ id?: string; value?: unknown }> = [];
    if (mode !== "start" && checkpointer) {
      const snap = await getCheckpointState(cfg);
      pendingResumeInterrupts = (snap.tasks ?? []).flatMap((task) => task.interrupts ?? []);
      // `threadId` lets interrupts saved by earlier releases (keyed
      // `<threadId>:<nodeId>`) resume without re-running approved tools.
      const pending = pendingInterrupts(snap);
      replay = replayStoreFromInterrupts(pending.values, { threadId, taskRoots: pending.taskRoots });
      seedInterruptDeadlines(replay, pending.values, pending.taskRoots);
      await hydrateDurableRuntime(snap, threadId, graphSpec, {
        executeInvoke,
        nodePolicy: opts.nodePolicy,
        rehydrateWebhooks: mode !== "resume",
        ...(runOpts.signal ? { signal: runOpts.signal } : {}),
        ...(runOpts.sinks ? { sinks: runOpts.sinks } : {}),
      });
      const expired = timeoutResumeCommand(snap, clock());
      if (expired) {
        // Keep the caller's answers for gates that are not overdue; only the
        // overdue interrupt(s) are replaced with the timeout command.
        payload = mergeTimeoutResume(payload, expired);
        mode = "resume";
      }
    }
    if (mode === "resume") {
      answeredResumeIds = resumeAnswerIds(payload, pendingResumeInterrupts);
      if (!overrides.preserveWebhookRoutes) {
        for (const id of answeredResumeIds) unregisterWebhookRoute(threadId, undefined, id);
      }
    }

    const runScope: RunScope = { replay, path: [], meta: runMeta, signal: runOpts.signal, pauseSignal: runOpts.pauseSignal };
    (cfg["configurable"] as Record<string, unknown>)[RUN_SCOPE_KEY] = runScope;
    const raised = new Set(pendingResumeInterrupts.map(it => interruptFingerprint(toInterruptInfo(it))));
    const emitStopInterrupts = (interrupts: InterruptInfo[]) => {
      const newInterruptIds: string[] = [];
      for (const info of interrupts) {
        const fingerprint = interruptFingerprint(info);
        if (raised.has(fingerprint)) continue;
        raised.add(fingerprint);
        if (info.id) newInterruptIds.push(info.id);
      }
      // A stop is a transport boundary even when every remaining gate was
      // announced earlier. Notification clients can use newInterruptIds.
      events.emit("interrupt.raised", { interrupts, newInterruptIds });
    };

    const startEvent =
      mode === "resume" ? "interrupt.resumed" : mode === "continue" ? "run.continued" : "run.start";
    events.emit(startEvent, {
      graphName: graphSpec.metadata.name,
    });

    const requestedCheckpoint = (runOpts as ResumeOptions).checkpointId;
    if (requestedCheckpoint && checkpointer) {
      const found = await checkpointer.getTuple({
        configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: requestedCheckpoint },
      });
      if (!found) {
        const retentionOn =
          !!retention &&
          "retention" in retention &&
          (retention as { retention?: { enabled?: boolean } }).retention?.enabled !== false;
        const error = checkpointPrunedError(threadId, requestedCheckpoint, { retention: retentionOn });
        events.emit("run.error", { message: error.message, error: error.message, durationMs: Date.now() - startMs });
        // Do not record this as a pause. The outer exit restores the saved status.
        return finish({ status: "error", state: {}, runId, threadId, error, durationMs: Date.now() - startMs }, false, false);
      }
    }

    enteredRun = true;
    try {
      let current: Record<string, unknown> | Command | null = payload;

      if (mode === "start" && current != null && !(current instanceof Command) && hooks.has("run:before")) {
        const r = await hooks.run("run:before", {
          state: current,
          run: runMeta,
          payload: { input: current as Record<string, unknown> },
        });
        if (r.payload.input) current = r.payload.input;
        // A run:before hook's replacement input is run input too.
        assertNoReservedInput(current, `graph "${graphSpec.metadata.name}" run (after run:before hooks)`);
      }

      // Bind this thread's memory scope (subject rendered from input/run at start;
      // stored binding reused on resume/continue so a resume can't switch scope).
      const memoryRuntime = (baseCtx as Record<symbol, unknown>)[MEMORY_RUNTIME] as MemoryRuntime | undefined;
      if (memoryRuntime?.exposeMemory) {
        const inputForSubject = mode === "start" && current != null && !(current instanceof Command) ? current : {};
        const binding = await memoryRuntime.beginRun(threadId, mode, { input: inputForSubject, run: runMeta });
        if (binding) {
          runMeta.memoryScope = Object.freeze({
            org: binding.org,
            project: binding.project,
            graph: binding.graph,
            ...(binding.user ? { user: binding.user } : {}),
            ...(binding.subject ? { subject: { ...binding.subject } } : {}),
          });
        }
      }

      if (current instanceof Command && hooks.has("interrupt:beforeResume")) {
        const resumeVal = (runOpts as ResumeOptions).resume;
        await hooks.run("interrupt:beforeResume", {
          state: {},
          run: runMeta,
          payload: { interruptPayload: resumeVal },
        });
      }

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = ((await compiledLg.invoke(
          current as Parameters<typeof compiledLg.invoke>[0],
          { ...cfg, signal: runOpts.signal } as Parameters<typeof compiledLg.invoke>[1],
        )) ?? {}) as Record<string, unknown>;
        // Time-travel checkpoint_id applies only to the first superstep.
        if (cfg.configurable && typeof cfg.configurable === "object") {
          delete (cfg.configurable as Record<string, unknown>)["checkpoint_id"];
        }

        const interrupts = extractInterrupts(result);

        if (hooks.has("interrupt:beforeRaise") && interrupts.length > 0) {
          await hooks.run("interrupt:beforeRaise", {
            state: result,
            run: runMeta,
            payload: {
              ...(interrupts[0]?.reason ? { reason: interrupts[0].reason } : {}),
              interruptPayload: interrupts[0]?.payload,
            },
          });
        }

        if (isPauseInterrupt(interrupts)) {
          const clean = stripReserved(result);
          events.emit("run.paused", { state: clean, durationMs: Date.now() - startMs });
          return finish({
            status: "paused",
            state: clean,
            runId,
            threadId,
            durationMs: Date.now() - startMs,
          });
        }

        if (interrupts.length === 0 && overrides.singleStep && checkpointer) {
          const snap = await compiledLg.getState(cfg);
          if (snap && Array.isArray(snap.next) && snap.next.length > 0) {
            const clean = stripReserved(result);
            events.emit("run.paused", { state: clean, next: [...new Set(snap.next.map(publicNodeId))], step: true, durationMs: Date.now() - startMs });
            return finish({ status: "paused", state: clean, runId, threadId, durationMs: Date.now() - startMs });
          }
        }

        if (interrupts.length === 0) {
          if (checkpointer && (interruptBefore.length || interruptAfter.length)) {
            const snap = await compiledLg.getState(cfg);
            if (snap && Array.isArray(snap.next) && snap.next.length > 0) {
              const clean = stripReserved(result);
              const next = [...new Set(snap.next.map(publicNodeId))];
              const bp: InterruptInfo[] = [{ id: `breakpoint:${next.join(",")}`, reason: `Paused before: ${next.join(", ")}` }];
              events.emit("interrupt.raised", { interrupts: bp });
              if (policy === "fail" || policy === "webhook" || !runOpts.resolveInterrupt) {
                return finish({ status: "interrupted", state: clean, runId, threadId, interrupts: bp, durationMs: Date.now() - startMs });
              }
              const resolveBreakpoint = runOpts.resolveInterrupt;
              await awaitAnswer(() => resolveBreakpoint(bp));
              // Continue past a static breakpoint with no input; an empty Command is rejected.
              current = null;
              continue;
            }
          }
          const clean = stripReserved(result);
          if (hooks.has("run:after")) {
            await hooks.run("run:after", { state: clean, run: runMeta, payload: { update: clean } });
          }
          events.emit("run.end", { state: clean, durationMs: Date.now() - startMs });
          await maybeTerminateServices(graphSpec, threadId, result, opts.nodePolicy);
          return finish({ status: "completed", state: clean, runId, threadId, durationMs: Date.now() - startMs });
        }

        const exhausted = interrupts.filter((i) => i.exhausted);
        if (exhausted.length > 0) {
          // Re-prompt budget spent: fail this run, but leave the interrupt
          // pending in the checkpoint so the thread stays inspectable and a
          // later valid resume can still complete the node.
          const clean = stripReserved(result);
          const message = exhausted.map(describeExhausted).join("; ");
          const error = new ResumeAttemptsExhaustedError(message);
          for (const it of exhausted) {
            const nodeId = (it.payload as { data?: { __nodeId?: string } } | undefined)?.data?.__nodeId;
            events.emit(
              "node.error",
              { nodeId, error: message, resumeAttemptsExhausted: true, interruptId: it.id },
              nodeId ? { nodeId } : {},
            );
          }
          events.emit("run.error", { message, error: message, durationMs: Date.now() - startMs });
          return finish({
            status: "error",
            state: clean,
            runId,
            threadId,
            interrupts,
            error,
            durationMs: Date.now() - startMs,
          });
        }

        await attachWebhookUrls(interrupts, {
          threadId,
          graphSpec,
          executeInvoke,
          nodePolicy: opts.nodePolicy,
          ...(runOpts.signal ? { signal: runOpts.signal } : {}),
          ...(runOpts.sinks ? { sinks: runOpts.sinks } : {}),
        });

        emitStopInterrupts(interrupts);

        if (policy === "fail" || policy === "webhook") {
          const onWaitDeadline = () => {
            const at = clock();
            const overdue = interrupts.filter((it) => it.deadlineAt !== undefined && Date.parse(it.deadlineAt) <= at);
            if (overdue.length === 0) {
              // An early fire (clock skew, a short delay) should re-arm, not drop the timer.
              scheduleWaitTimeoutTimer(waitTimers, threadId, interrupts, onWaitDeadline, clock, scheduleTimeout);
              return;
            }
            executeInvoke(
              new Command({ resume: Object.fromEntries(overdue.map((it) => [it.id, { timedOut: true }])) }),
              { threadId, resume: { timedOut: true }, onInterrupt: "fail" },
              "resume",
              { preserveWebhookRoutes: true, backgroundWaitTimeout: true },
            ).then(
              (timedOutResult) => {
                for (const it of overdue) unregisterWebhookRoute(threadId, undefined, it.id);
                try {
                  opts.onWaitTimeout?.(timedOutResult);
                } catch (cbErr) {
                  const m = cbErr instanceof Error ? cbErr.message : String(cbErr);
                  events.emit("run.error", { message: `onWaitTimeout callback failed: ${m}`, error: m, threadId });
                }
              },
              (err: unknown) => {
                if ((err as { code?: string } | undefined)?.code === "THREAD_BUSY") return;
                // executeInvoke normally returns status "error"; this catches anything that escaped it
                // so a background timer can never become an unhandled rejection.
                const m = err instanceof Error ? err.message : String(err);
                events.emit("run.error", { message: `wait timeout resume failed: ${m}`, error: m, threadId });
                try {
                  opts.onWaitTimeout?.({
                    status: "error",
                    state: {},
                    runId,
                    threadId,
                    error: err instanceof Error ? err : new Error(m),
                    durationMs: 0,
                  });
                } catch {
                  /* already reported */
                }
              },
            );
          };
          scheduleWaitTimeoutTimer(waitTimers, threadId, interrupts, onWaitDeadline, clock, scheduleTimeout);
          const clean = stripReserved(result);
          return finish({
            status: "interrupted",
            state: clean,
            runId,
            threadId,
            interrupts,
            durationMs: Date.now() - startMs,
          });
        }

        // Resolving via prompt/approve — drop the HTTP listener for this thread.
        unregisterWebhookRoute(threadId);

        let resumeValue: unknown;
        if (runOpts.resolveInterrupt) {
          const resolve = runOpts.resolveInterrupt;
          resumeValue = await awaitAnswer(() => resolve(interrupts));
        } else if (policy === "approve") {
          resumeValue = Object.fromEntries(interruptIds(interrupts).map((id) => [id, true]));
        } else {
          const clean = stripReserved(result);
          return finish({
            status: "interrupted",
            state: clean,
            runId,
            threadId,
            interrupts,
            durationMs: Date.now() - startMs,
          });
        }

        events.emit("interrupt.resumed", { resume: resumeValue });
        current = resumeCommand(resumeValue, interrupts, threadId);
      }
    } catch (err) {
      let error = err instanceof Error ? err : new Error(String(err));
      if (error.name === "GraphRecursionError") {
        let pending = spec.nodes.map(n => n.id).slice(0, 10);
        try { pending = [...(await compiledLg.getState(cfg)).next]; } catch { /* no checkpointer */ }
        error = Object.assign(new Error(`Graph "${graphSpec.metadata.name}" reached runtime.recursionLimit (${graphSpec.runtime?.recursionLimit ?? 1000}) in this invocation; pending/graph nodes: ${pending.join(", ")}. Add a terminating route or increase runtime.recursionLimit. The counter restarts on resume.`, { cause: error }), { code: "RECURSION_LIMIT", retryable: false });
      }
      if (isAbortFailure(err, runOpts.signal)) {
        events.emit("run.aborted", { message: error.message, error: error.message, durationMs: Date.now() - startMs });
        await maybeTerminateServices(graphSpec, threadId, undefined, opts.nodePolicy);
        return finish({ status: "aborted", state: {}, runId, threadId, error, durationMs: Date.now() - startMs });
      }
      if (hooks.has("run:error")) {
        try { await hooks.run("run:error", { state: {}, run: runMeta, payload: { error } }); } catch { /* ignore */ }
      }
      events.emit("run.error", { message: error.message, error: error.message, durationMs: Date.now() - startMs });
      await maybeTerminateServices(graphSpec, threadId, undefined, opts.nodePolicy);
      // A thread that moved on belongs to someone else now: release this run
      // without writing its status over theirs.
      const movedOn = (err as { code?: unknown } | null)?.code === THREAD_MOVED_ON;
      return finish({ status: "error", state: {}, runId, threadId, error, durationMs: Date.now() - startMs }, !movedOn);
    } finally {
      delete (baseCtx as RunContext & { pauseSignal?: AbortSignal }).pauseSignal;
      for (const u of unsubs) u();
    }
    } finally {
      if (!enteredRun) {
        if (retentionOpen) {
          retentionOpen = false;
          try {
            retention?.endThreadRun?.(threadId, "active", runToken, false, true);
          } catch {
            /* releasing the guard must not hide the original error */
          }
        }
        if (priorRead && activeMark) {
          try {
            await retention?.restoreThreadStatus?.(threadId, priorStatus, activeMark, markedAt);
          } catch {
            /* restoring status must not hide the original error */
          }
        }
      }
      delete (baseCtx as RunContext & { pauseSignal?: AbortSignal }).pauseSignal;
      for (const u of unsubs) u();
    }
  };

  const executeInvoke = async (
    payload: Record<string, unknown> | Command | null,
    runOpts: RunOptions | ResumeOptions | ContinueOptions,
    mode: ExecuteMode,
    overrides: InvokeOverrides = {},
  ): Promise<RunResult> => {
    const threadId = runOpts.threadId ?? `thread-${runId}`;
    return withEventThread(threadId, async () => {
      const checkpointId = (runOpts as ResumeOptions).checkpointId;
      const config = { configurable: { thread_id: threadId, ...(checkpointId ? { checkpoint_id: checkpointId } : {}) } };
      if (mode !== "start" && (!checkpointer || (!checkpointId && !await checkpointer.getTuple(config)))) {
        throw threadAdmissionError("THREAD_NOT_FOUND", threadId, "does not exist; no checkpoint was changed.");
      }
      let claim = overrides.threadClaim;
      if (!claim) {
        const until = performance.now() + (overrides.backgroundWaitTimeout ? 5000 : 0);
        for (;;) {
          try { claim = await acquireThreadRun(checkpointer ?? compiledLg, threadId); break; }
          catch (err) {
            if ((err as { code?: unknown }).code !== "THREAD_BUSY" || performance.now() >= until) throw err;
            await new Promise<void>(resolve => { const timer = setTimeout(resolve, 25); timer.unref(); });
          }
        }
      }
      try {
        if (mode !== "start" && checkpointer) {
          const tuple = await checkpointer.getTuple(config);
          if (!tuple && !checkpointId) throw threadAdmissionError("THREAD_NOT_FOUND", threadId, "does not exist.");
          if (tuple) {
            if (checkpointId && tuple.pendingWrites?.some(([, channel]) => channel === "__resume__")) {
              throw threadAdmissionError("HISTORICAL_DECISION_REPLAY", threadId, "already has an answer at this checkpoint; fork before the gate for a new decision.");
            }
            const snap = await getCheckpointState(config);
            const pending = (snap.tasks ?? []).flatMap(task => task.interrupts ?? []);
            if (pending.length) {
              if (mode === "continue") {
                if (!isPauseInterrupt(pending.map(toInterruptInfo))) throw resumeValueRequiredError(threadId);
                payload = new Command({ resume: Object.fromEntries(interruptIds(pending).map(id => [id, true])) });
              } else {
                const answer = payload instanceof Command ? payload.resume : (runOpts as ResumeOptions).resume;
                if (answer === undefined) throw resumeValueRequiredError(threadId);
                payload = resumeCommand(answer, pending, threadId);
              }
            } else if (snap.next.length > 0) payload = null;
            else throw threadAdmissionError("THREAD_NOT_WAITING", threadId, "has no pending work or decision; no checkpoint was changed.");
          }
        }
        return await invokeOwned(payload, runOpts, mode, overrides);
      } finally {
        await claim.release();
      }
    });
  };

  const toSnapshot = (
    snap: { values: Record<string, unknown>; next: readonly string[]; config?: { configurable?: { checkpoint_id?: string } }; createdAt?: string; tasks?: ReadonlyArray<{ name?: string; interrupts?: ReadonlyArray<{ id?: string; value?: unknown }> }> },
    threadId?: string,
  ): StateSnapshot => {
    const interrupts: InterruptInfo[] = [];
    const next = [...new Set(snap.next.map(publicNodeId))];
    for (const task of snap.tasks ?? []) {
      for (const it of task.interrupts ?? []) {
        interrupts.push(toInterruptInfo(it));
      }
      // LangGraph drops a task from `next` once it has pending writes (e.g. the
      // persisted resume values of a re-prompted hitl node), even though it is
      // still waiting on an interrupt. Report it as pending.
      if ((task.interrupts?.length ?? 0) > 0 && task.name && !next.includes(publicNodeId(task.name))) {
        next.push(publicNodeId(task.name));
      }
    }
    if (threadId) enrichInterruptsWithWebhookUrls(interrupts, threadId);
    if (
      interrupts.length === 0 &&
      snap.next.length > 0 &&
      (interruptBefore.length || interruptAfter.length)
    ) {
      interrupts.push({
        id: `breakpoint:${next.join(",")}`,
        reason: `Paused before: ${next.join(", ")}`,
      });
    }
    return {
      values: stripReserved(snap.values),
      next,
      checkpointId: snap.config?.configurable?.checkpoint_id,
      createdAt: snap.createdAt,
      interrupts,
    };
  };

  const continueRun = async (
    continueOpts: ContinueOptions,
    overrides: InvokeOverrides = {},
  ): Promise<RunResult> => {
    let payload: Record<string, unknown> | Command | null = null;
    if (checkpointer) {
      const snap = await getCheckpointState({ configurable: { thread_id: continueOpts.threadId } });
      const hasInterrupt = (snap?.tasks ?? []).some(
        (t) => Array.isArray(t.interrupts) && t.interrupts.length > 0,
      );
      if (hasInterrupt) {
        // LangGraph rejects Command({ resume: null }) as empty input.
        // Key the continue over every pending id so a truthy unkeyed
        // value is not refused when several interrupts are waiting.
        const pending = (snap?.tasks ?? []).flatMap((t) => t.interrupts ?? []);
        if (!isPauseInterrupt(pending.map(toInterruptInfo))) throw resumeValueRequiredError(continueOpts.threadId);
        payload = new Command({
          resume: Object.fromEntries(interruptIds(pending).map((id) => [id, true])),
        });
      }
    }
    return executeInvoke(payload, continueOpts, "continue", overrides);
  };

  const resume = async (resumeOpts: ResumeOptions): Promise<RunResult> => {
    let payload: Record<string, unknown> | Command | null = new Command({
      resume: resumeOpts.resume,
    });
    if (checkpointer) {
      const config = { configurable: { thread_id: resumeOpts.threadId, ...(resumeOpts.checkpointId ? { checkpoint_id: resumeOpts.checkpointId } : {}) } };
      if (resumeOpts.checkpointId) {
        const tuple = await checkpointer.getTuple(config);
        const latest = await checkpointer.getTuple({ configurable: { thread_id: resumeOpts.threadId } });
        if (resumeOpts.checkpointId !== latest?.checkpoint.id && tuple?.pendingWrites?.some(([, channel]) => channel === "__resume__")) {
          throw Object.assign(new Error(`Historical checkpoint "${resumeOpts.checkpointId}" already contains a decision; fork before the gate to make a new decision.`), { code: "HISTORICAL_DECISION_REPLAY", retryable: false });
        }
      }
      const snap = await getCheckpointState(config);
      const hasInterrupt = (snap?.tasks ?? []).some(
        (t) => Array.isArray(t.interrupts) && t.interrupts.length > 0,
      );
      if (hasInterrupt) {
        // A missing answer is not a denial: fail before anything runs and leave the interrupt pending.
        const pending = (snap?.tasks ?? []).flatMap((t) => t.interrupts ?? []);
        const answer = resumeOpts.resume === undefined && isPauseInterrupt(pending.map(toInterruptInfo)) ? true : resumeOpts.resume;
        if (answer === undefined) throw resumeValueRequiredError(resumeOpts.threadId);
        payload = resumeCommand(answer, pending, resumeOpts.threadId);
      }
      // Static breakpoints pause with empty task.interrupts and a non-empty
      // `next`. LangGraph continues those with null input, not Command({ resume }).
      if (!hasInterrupt && Array.isArray(snap?.next) && snap.next.length > 0) {
        payload = null;
      }
    }
    return executeInvoke(payload, resumeOpts, "resume");
  };

  return {
    spec: graphSpec,
    runId,
    events,
    placements: plan?.decisions ?? [],
    run: (runOpts: RunOptions = {}) => executeInvoke(runOpts.input ?? {}, runOpts, "start"),
    resume,
    continueRun: (opts: ContinueOptions) => continueRun(opts),
    getState: async (threadId: string, stateOpts?: { applyWaitTimeouts?: boolean }) => {
      if (!checkpointer) return null;
      let snap = await getCheckpointState({ configurable: { thread_id: threadId } });
      if (stateOpts?.applyWaitTimeouts === false) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return toSnapshot(snap as any, threadId);
      }
      await hydrateDurableRuntime(snap, threadId, graphSpec, { executeInvoke, nodePolicy: opts.nodePolicy, rehydrateWebhooks: true });
      const expired = timeoutResumeCommand(snap, clock());
      if (expired) {
        await executeInvoke(expired, { threadId, resume: { timedOut: true }, onInterrupt: "fail" }, "resume", { preserveWebhookRoutes: true });
        for (const id of Object.keys(expired.resume as Record<string, unknown>)) {
          unregisterWebhookRoute(threadId, undefined, id);
        }
        snap = await getCheckpointState({ configurable: { thread_id: threadId } });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return toSnapshot(snap as any, threadId);
    },
    getStateHistory: async (threadId: string) => {
      if (!checkpointer) return [];
      const snapshots: StateSnapshot[] = [];
      for await (const snap of compiledLg.getStateHistory({ configurable: { thread_id: threadId } })) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snapshots.push(toSnapshot(snap as any, threadId));
      }
      return snapshots;
    },
    resumeFrom: async (opts: ResumeOptions & { checkpointId: string }) => {
      return resume({ ...opts, checkpointId: opts.checkpointId });
    },
    step: async (opts: ContinueOptions) => {
      if (!checkpointer) {
        throw new Error("step() needs a checkpointer: stepping resumes a checkpointed thread one superstep at a time.");
      }
      // Per-invocation interruptAfter: "*" — the shared spec / compiled graph is
      // never mutated, so concurrent run()/step() calls don't affect each other.
      return continueRun(opts, { singleStep: true });
    },
    stream: async function* (runOpts: RunOptions = {}) {
      const threadId = runOpts.threadId ?? `thread-${runId}`;
      const claim = await acquireThreadRun(checkpointer ?? compiledLg, threadId);
      const stopped = new AbortController();
      const source = events.stream({ threadId, includeBuffered: false, signal: stopped.signal })[Symbol.asyncIterator]();
      let next = source.next(); // Subscribe before execution can emit its first event.
      const running = executeInvoke(runOpts.input ?? {}, { ...runOpts, threadId }, "start", { threadClaim: claim });
      running.then(() => stopped.abort(), () => stopped.abort());
      try {
        for (;;) {
          const event = await next;
          if (event.done) break;
          yield event.value;
          next = source.next();
        }
        await running;
      } finally {
        stopped.abort();
        await source.return?.();
      }
    },
  };
}

async function assembleCompiledLangGraph(
  spec: GraphSpec,
  opts: CompileOptions,
  plan?: PlacementPlan,
): Promise<AssembledGraph> {
  const sourceFile = graphFile(spec);
  // Auto-declare channels targeted by output/collect/stateMap.out so LangGraph
  // does not silently drop node updates when authors omit state.channels entries.
  spec = ensureDeclaredOutputChannels(spec);
  const policyEdges = spec.nodes.flatMap(node => recoveryTargets(spec, node, opts.hooks).map(to => ({ from: node.id, to })));
  const invalidTopology = topologyDiagnostics({ ...spec, edges: [...spec.edges, ...policyEdges] }).filter((d) => d.severity === "error");
  if (invalidTopology.length) throw new Error(`Invalid graph: ${invalidTopology.map((d) => `${d.code}: ${d.message}`).join("; ")}`);

  const cwd = opts.cwd ?? process.cwd();
  const graphDir =
    opts.graphPath != null
      ? path.dirname(path.resolve(cwd, opts.graphPath))
      : sourceFile ? path.dirname(sourceFile) : cwd;
  const graphWorkspace = opts.workspace !== undefined
    ? path.resolve(cwd, opts.workspace)
    : resolveGraphWorkspace(spec, graphDir);
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const events = createEventBus({ runId, graph: spec.metadata.name });
  for (const sink of opts.sinks ?? []) events.subscribe(sink);

  for (const extra of opts.extraFactories ?? []) {
    if (!registry.has(extra.type)) registry.register(extra);
  }
  // Providers stay with this graph (see GRAPH_PROVIDERS below). Without a
  // policy they are also registered process-wide, as before, for code that
  // looks them up by name outside a run.
  if (!opts.nodePolicy) for (const provider of opts.providers ?? []) registerProvider(provider);

  // Refused before anything is loaded: imports register modules for the whole process.
  assertImportsAllowed(opts.nodePolicy, spec, `graph "${spec.metadata?.name ?? "graph"}"`);
  const imported = await loadGraphImports(spec, { cwd: graphDir });
  const skillAliases: Record<string, string> = { ...(opts.runConfig?.skills ?? {}), ...imported.skillAliases };
  const agentAliases: Record<string, string> = { ...(opts.runConfig?.agents ?? {}), ...imported.agentAliases };
  const subgraphAliases: Record<string, string> = { ...(opts.runConfig?.subgraphs ?? {}), ...imported.subgraphAliases };

  const StateAnnotation = buildStateAnnotation(spec, (msg, data) => {
    events.emit("log", { level: "warn", msg, ...data }, {});
  });
  const graph = new StateGraph(StateAnnotation);
  const executionLimit = createExecutionLimit(spec.runtime?.concurrency);

  let budget: BudgetState | undefined;
  if (spec.runtime?.budget) {
    budget = {
      maxUSD: spec.runtime.budget.maxUSD,
      maxTokens: spec.runtime.budget.maxTokens,
      onExceed: spec.runtime.budget.onExceed ?? "warn",
      usedTokens: 0,
      usedUSD: 0,
    };
  }

  assertGraphToolsAllowed(opts.nodePolicy, spec, `graph "${spec.metadata?.name ?? "graph"}"`);
  assertGraphRuntimeAllowed(opts.nodePolicy, spec, `graph "${spec.metadata?.name ?? "graph"}"`);
  {
    // Every node, map inner and inline subgraph (and its declared channels) at any depth.
    const channels = [...Object.keys(spec.state?.channels ?? {})];
    walkNodes(spec, (n) => {
      channels.push(...collectNodeWriteChannels(n as NodeSpec));
      const inline = (n as { spec?: GraphSpec }).spec;
      if (inline && typeof inline === "object") channels.push(...Object.keys(inline.state?.channels ?? {}));
      assertReplaySafeNodeId((n as { id?: unknown }).id);
      assertNodeSpecAllowed(opts.nodePolicy, n as { type?: unknown; with?: unknown }, `node "${String((n as { id?: unknown }).id ?? "?")}"`);
    });
    assertNoReservedChannels(opts.nodePolicy, channels, `graph "${spec.metadata?.name ?? "graph"}"`);
  }
  // A policy that refuses MCP also withholds the host's hub, so nothing in the run can reach it.
  const exposed = demoToolExposureDiagnostics(spec)[0];
  if (exposed) throw new Error(`${exposed.path}: ${exposed.message}`);
  const mcpHub = opts.nodePolicy?.blockMcp ? undefined : opts.mcp;
  const toolWiring: ToolWiring = { mcp: mcpHub };
  const compiledNodes = new Map<string, ReturnType<NodeFactory["build"]>>();
  const sharedHistory = sharedHistoryChannels(spec.nodes as unknown as Array<Record<string, unknown>>);

  const hooks: HookBus = createHookBus(events);
  for (const h of defaultGuardrailHooks(spec)) hooks.register(h);
  for (const h of hooksFromSpec(spec)) hooks.register(h);
  for (const h of opts.hooks ?? []) hooks.register(h);

  const { runtime: memoryRuntime, store } = resolveMemory(spec, opts);

  const baseCtx: Partial<RunContext> = {
    config: {
      ...(opts.runConfig ?? {}),
      graphDir,
      defaults: { ...(spec.config?.defaults ?? {}), ...(opts.runConfig?.defaults ?? {}) },
      vars: { ...(spec.config?.vars ?? {}), ...(opts.runConfig?.vars ?? {}) },
      skills: skillAliases,
      agents: agentAliases,
      subgraphs: subgraphAliases,
      // Parent channel reducers for subgraph merge-back. Set after
      // ensureDeclaredOutputChannels so auto-declared targets are included.
      channels: spec.state?.channels ?? {},
    },
    secrets: createEnvSecretProvider(),
    events,
    workspace: graphWorkspace,
    budget,
    hooks,
    mcp: mcpHub,
    store,
  };
  if (memoryRuntime) (baseCtx as Record<symbol, unknown>)[MEMORY_RUNTIME] = memoryRuntime;
  if (opts.nodePolicy) (baseCtx as Record<symbol, unknown>)[NODE_POLICY] = opts.nodePolicy;
  if (opts.providers?.length || opts.nodePolicy) {
    const graphProviders: GraphProviders = {
      byName: new Map((opts.providers ?? []).map((p) => [p.name, p])),
      // Under a policy, nothing outside what the graph was compiled with.
      exclusive: !!opts.nodePolicy,
    };
    (baseCtx as Record<symbol, unknown>)[GRAPH_PROVIDERS] = graphProviders;
  }
  {
    // Media providers: explicit ones first, then those implied by `providers:`
    // (a langchain xai/openai entry doubles as an image/video provider).
    const media = [...(opts.mediaProviders ?? []), ...deriveMediaProviders(spec.providers)];
    if (media.length) {
      const graphMedia: GraphMediaProviders = { byName: new Map(media.map((p) => [p.name, p])) };
      (baseCtx as Record<symbol, unknown>)[GRAPH_MEDIA_PROVIDERS] = graphMedia;
    }
  }

  const defaultRetry = spec.runtime?.retry;
  const defaultTimeout = spec.runtime?.timeoutDefault;

  const mapJoinById = new Map<string, string>();

  for (const nodeSpec of spec.nodes) {
    assertNodeTypeAllowed(opts.nodePolicy, nodeSpec.type, `node "${nodeSpec.id}"`);
    assertHostProbeAllowed(opts.nodePolicy, (nodeSpec.with as { requires?: unknown[] } | undefined)?.requires, `node "${nodeSpec.id}"`);
    assertNodeSpecAllowed(opts.nodePolicy, nodeSpec, `node "${nodeSpec.id}"`);
    if (nodeSpec.type === "map") {
      const inner = (nodeSpec.with as { node?: { type?: unknown; with?: { requires?: unknown[] } } } | undefined)?.node;
      if (typeof inner?.type === "string") assertNodeTypeAllowed(opts.nodePolicy, inner.type, `map node "${nodeSpec.id}" inner node`);
      assertHostProbeAllowed(opts.nodePolicy, inner?.with?.requires, `map node "${nodeSpec.id}" inner node`);
      if (inner) assertNodeSpecAllowed(opts.nodePolicy, inner, `map node "${nodeSpec.id}" inner node`);
    }
    const factory = registry.get(nodeSpec.type);
    if (!factory) throw new Error(`Node type "${nodeSpec.type}" is not registered.`);

    const configResult = factory.configSchema.safeParse(nodeSpec.with ?? {});
    if (!configResult.success) {
      throw new Error(
        `Node "${nodeSpec.id}" config error: ` +
          configResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
    }

    if (nodeSpec.type === "map") {
      addCheckpointedMap(
        graph,
        spec,
        nodeSpec,
        configResult.data,
        {
          runId,
          events,
          baseCtx,
          graphWorkspace,
          hooks,
          toolWiring,
          defaultRetry,
          defaultTimeout,
          executionLimit,
          externalHooks: opts.hooks,
        },
        mapJoinById,
      );
      continue;
    }

    const remoteExec = plan?.remote.get(nodeSpec.id);
    const built = factory.build(
      {
        graphName: spec.metadata.name,
        toolWiring,
        ...(remoteExec ? { remote: remoteExec } : {}),
        ...(spec.runtime?.worktrees?.root ? { worktreeRoot: spec.runtime.worktrees.root } : {}),
        ...(spec.runtime?.context ? { contextDefaults: spec.runtime.context } : {}),
        sharedHistoryChannels: sharedHistory,
      } as Parameters<typeof factory.build>[0],
      nodeSpec as unknown as Record<string, unknown>,
      configResult.data,
    );
    const compiled = remoteExec ? placeRemotely(built, nodeSpec, configResult.data, remoteExec) : built;
    compiledNodes.set(nodeSpec.id, compiled);

    const nodeRetry = nodeSpec.retry ?? defaultRetry;
    const nodeTimeout = nodeSpec.timeout ?? defaultTimeout;
    const scope = { nodeId: nodeSpec.id, nodeType: nodeSpec.type };
    const nsRecord = nodeSpec as unknown as Record<string, unknown>;

    type NodeRun = { res: NodeResult; ctx: NodeRunContext & { _onceUpdates: Record<string, unknown>; _issueUpdates: RunIssue[] } };
    const stopsOnTimeout = compiled.capabilities?.stopsOnTimeout === true;
    const runOnce = (
      state: Record<string, unknown>,
      inputOverride?: Record<string, unknown>,
      lgConfig?: LangGraphRunnableConfig,
      attemptBase = 0,
    ): Promise<NodeRun> =>
      runWithPolicy<NodeRun>(
        (attempt, signal) => {
          const ctx = buildNodeCtx(nsRecord, state, baseCtx, events, graphWorkspace, attemptBase + attempt, inputOverride, lgConfig);
          if (signal && stopsOnTimeout) ctx.signal = signal;
          return compiled.run(state, ctx).then((res) => {
            finishInterruptDeadline(runScopeOf(lgConfig), nodeSpec.id);
            return { res, ctx };
          });
        },
        {
          retry: nodeRetry as RetryConfigInput,
          timeout: nodeTimeout,
          signal: runSignalOf(lgConfig, baseCtx.signal),
          stopGraceMs: stopsOnTimeout ? TIMED_OUT_ATTEMPT_STOP_MS : 0,
          onRetry: (info) => events.emit("node.retry", { nodeId: nodeSpec.id, ...info }, scope),
          onTimeout: (info) => events.emit("node.timeout", { nodeId: nodeSpec.id, ...info }, scope),
        },
      );

    // A node's update loses reserved channels its type does not own; engine
    // bookkeeping (`__once`, `__issues`) is added afterwards. Also applied to
    // what node:after / state:beforeUpdate hooks hand back.
    const sealUpdate = (update: Record<string, unknown>, run: NodeRun): Record<string, unknown> => {
      const sealed = { ...dropUnownedReserved(update, nodeSpec.type, opts.nodePolicy) };
      if (Object.keys(run.ctx._onceUpdates).length > 0) sealed[ONCE_CHANNEL] = run.ctx._onceUpdates;
      if (run.ctx._issueUpdates.length > 0) sealed[ISSUES_CHANNEL] = run.ctx._issueUpdates;
      return sealed;
    };
    const finalizeUpdate = (run: NodeRun): Record<string, unknown> => sealUpdate(resultToUpdate(run.res), run);

    // Routers (and any routing-capable node) declare Command.goto destinations via
    // `ends` so LangGraph accepts goto without requiring a duplicate branch edge.
    const recovery = recoveryTargets(spec, nodeSpec, opts.hooks);
    const routeEnds = [...new Set([...collectRouteEnds(nodeSpec), ...nodeRouteTargets(spec, nodeSpec.id), ...nodeToolTargets(spec, nodeSpec.id), ...recovery].map(target => target === "END" ? END : target))];
    const addNodeOpts = routeEnds.length > 0 ? { ends: routeEnds } : undefined;

    const executeNode = async (state: Record<string, unknown>, lgConfig?: LangGraphRunnableConfig) => {
      const runMeta = (runScopeOf(lgConfig)?.meta ?? baseCtx.meta ?? { runId, graph: spec.metadata.name, startedAt: "" }) as RunMeta;

      // Graceful pause: park before this node so continueRun can resume it.
      const pauseSignal = runScopeOf(lgConfig)?.pauseSignal;
      if (pauseSignal?.aborted) {
        const data = withReplayData(undefined, runScopeOf(lgConfig), nodeSpec.id);
        lgInterrupt({ reason: "paused", __flowgraphPause: true, ...(data !== undefined ? { data } : {}) });
      }

      // `when` guard
      if (nodeSpec.when) {
        const expr = nodeSpec.when.replace(/^\s*\{\{|\}\}\s*$/g, "").trim();
        const guardScope = { state, config: baseCtx.config ?? {}, run: runMeta };
        if (!evalGuard(expr, guardScope)) {
          events.emit("node.skipped", { nodeId: nodeSpec.id }, scope);
          return {};
        }
      }

      // node:before — mutate input / veto / route / interrupt
      let inputOverride: Record<string, unknown> | undefined;
      if (hooks.has("node:before")) {
        const rendered = nsRecord["input"]
          ? (renderDeep(nsRecord["input"] as Record<string, string>, { state, config: baseCtx.config, run: runMeta }) as Record<string, unknown>)
          : {};
        const r = await hooks.run("node:before", { state, run: runMeta, payload: { nodeId: nodeSpec.id, nodeType: nodeSpec.type, input: rendered } });
        const c = r.control;
        if (c?.kind === "veto") {
          events.emit("node.skipped", { nodeId: nodeSpec.id, reason: c.reason }, scope);
          return {};
        }
        if (c?.kind === "route") return new Command({ goto: c.to }) as unknown as Record<string, unknown>;
        if (c?.kind === "interrupt") {
          // Interrupt data carries the engine's `__nodeId` / `__agentReplay`; a hook supplies none.
          const data = c.payload && typeof c.payload === "object" && !Array.isArray(c.payload)
            ? withoutReservedKeys(c.payload as Record<string, unknown>)
            : c.payload;
          lgInterrupt({ reason: c.reason, data: withReplayData(data, runScopeOf(lgConfig), nodeSpec.id) });
        }
        inputOverride = r.payload.input as Record<string, unknown> | undefined;
      }

      // A placed node's events say where it ran (ADR-0020): the planned child before it starts,
      // the actual one (after retries and re-resolution) once it ends.
      const placedScope = (ranCtx?: unknown): typeof scope => {
        if (!remoteExec) return scope;
        const actual = (ranCtx as { _placement?: PlacementInfo } | undefined)?._placement;
        const childThreadId = actual?.childThreadId ?? remoteExec.plannedChildThreadId(runMeta.threadId);
        if (!childThreadId) return scope;
        return { ...scope, placement: { target: actual?.target ?? remoteExec.initialTarget, childThreadId } } as typeof scope;
      };
      events.emit("node.start", { nodeId: nodeSpec.id, type: nodeSpec.type }, placedScope());

      try {
        const run = await runOnce(state, inputOverride, lgConfig);
        // Capture goto before resultToUpdate strips it — routers (and any node
        // returning Command{ goto }) rely on this to drive exclusive routing.
        const nodeGoto =
          "command" in run.res && run.res.command.goto != null
            ? run.res.command.goto
            : undefined;
        let update = finalizeUpdate(run);

        // node:after — mutate output / route
        if (hooks.has("node:after")) {
          const r = await hooks.run("node:after", { state, run: runMeta, payload: { nodeId: nodeSpec.id, nodeType: nodeSpec.type, update } });
          const c = r.control;
          if (c?.kind === "route") {
            events.emit("node.end", { nodeId: nodeSpec.id, update, routed: c.to }, placedScope(run.ctx));
            return new Command({ goto: c.to, update }) as unknown as Record<string, unknown>;
          }
          update = sealUpdate((r.payload.update as Record<string, unknown> | undefined) ?? update, run);
        }

        // state:beforeUpdate — redact / transform the delta before commit
        if (hooks.has("state:beforeUpdate")) {
          const r = await hooks.run("state:beforeUpdate", { state, run: runMeta, payload: { nodeId: nodeSpec.id, nodeType: nodeSpec.type, update } });
          update = sealUpdate((r.payload.update as Record<string, unknown> | undefined) ?? update, run);
        }

        if (nodeGoto != null) {
          events.emit("node.end", { nodeId: nodeSpec.id, update, routed: nodeGoto }, placedScope(run.ctx));
          return new Command({ goto: nodeGoto, update }) as unknown as Record<string, unknown>;
        }

        events.emit("node.end", { nodeId: nodeSpec.id, update }, placedScope(run.ctx));
        return update;
      } catch (err) {
        if (isInterruptLike(err)) throw err; // let LangGraph handle the suspend

        // node:error — swallow (veto) / route / retry
        if (hooks.has("node:error")) {
          const error = err instanceof Error ? err : new Error(String(err));
          const r = await hooks.run("node:error", { state, run: runMeta, payload: { nodeId: nodeSpec.id, nodeType: nodeSpec.type, error } });
          const c = r.control;
          if (c?.kind === "veto") {
            events.emit("node.error", { nodeId: nodeSpec.id, error: error.message, swallowed: true }, scope);
            const swallowed: RunIssue = stampIssue(
              {
                code: "ERROR_SWALLOWED",
                severity: "warning",
                message: `node "${nodeSpec.id}" error was swallowed: ${error.message}`,
                impact: "The node did not produce its expected result; downstream steps may be incomplete.",
                nodeId: nodeSpec.id,
                nodeType: nodeSpec.type,
              },
              { nodeId: nodeSpec.id, nodeType: nodeSpec.type },
            );
            events.emit("run.issue", swallowed, scope);
            try {
              appendRunIssue(graphWorkspace, runIssuesKey(runMeta), swallowed);
            } catch {
              /* ignore */
            }
            return { [ISSUES_CHANNEL]: [swallowed] };
          }
          if (c?.kind === "route") {
            events.emit("node.error", { nodeId: nodeSpec.id, error: error.message, routed: c.to }, scope);
            return new Command({ goto: c.to }) as unknown as Record<string, unknown>;
          }
          if (c?.kind === "retry") {
            events.emit("node.retry", { nodeId: nodeSpec.id, reason: "hook" }, scope);
            // A placed node names its child run by attempt. A hook retry continues the numbering after the
            // attempts the policy used, so it gets a new child id; the numbering is a pure function of the
            // sequence, so a crash re-entry replays the same ids and re-attaches.
            const hookBase = remoteExec ? Math.max(1, nodeRetry?.maxAttempts ?? 1) : 0;
            const retried = await runOnce(state, inputOverride, lgConfig, hookBase);
            const update = finalizeUpdate(retried);
            events.emit("node.end", { nodeId: nodeSpec.id, update }, placedScope(retried.ctx));
            return update;
          }
        }
        const policy = nodeSpec.on?.error;
        if (policy === "continue" || policy === "ignore") {
          events.emit("node.error", { nodeId: nodeSpec.id, error: String(err), swallowed: true, policy }, scope);
          const issue = stampIssue({ code: "ERROR_SWALLOWED", severity: "warning", message: `node "${nodeSpec.id}" continued after an error: ${String(err)}`, impact: "The node produced no result; subsequent nodes and sibling branches continue." }, { nodeId: nodeSpec.id, nodeType: nodeSpec.type });
          events.emit("run.issue", issue, scope);
          return { [ISSUES_CHANNEL]: [issue] };
        }
        if (policy?.startsWith("route:")) {
          const to = policy.slice(6);
          events.emit("node.error", { nodeId: nodeSpec.id, error: String(err), routed: to }, scope);
          return new Command({ goto: to === "END" ? END : to }) as unknown as Record<string, unknown>;
        }
        events.emit("node.error", { nodeId: nodeSpec.id, error: String(err) }, scope);
        throw err;
      }
    };
    const routedNode = exclusiveRouting(nodeSpec.id, recovery.length > 0, executeNode);
    graph.addNode(nodeSpec.id,
      (state: Record<string, unknown>, lgConfig?: LangGraphRunnableConfig) =>
        executionLimit(() => routedNode(state, lgConfig), lgConfig, lgConfig?.signal ?? runSignalOf(lgConfig, baseCtx.signal)),
      addNodeOpts as Parameters<typeof graph.addNode>[2]);
  }

  // Node-as-tool: run a sibling node's logic with the agent-supplied args as
  // its input against the calling agent's state snapshot. Returns the node's
  // raw result (the outputs slug) so the LLM sees clean data, not the update envelope.
  toolWiring.invokeNode = async (id, args, ctx, state = {}) => {
    if (spec.nodes.find((n) => n.id === id)?.type === "map") {
      throw Object.assign(new Error(`node-as-tool: map node "${id}" cannot be called as a tool; put it in a subgraph and call that instead.`), { code: "NODE_TOOL_UNSUPPORTED", retryable: false });
    }
    // Reached only by a tool list the compiler can't see, such as a reusable agent definition.
    if (provesObjective(spec.nodes.find((n) => n.id === id))) {
      throw new Error(`node-as-tool: demo node "${id}" has an objective or steps, so it cannot be called as a tool.`);
    }
    const target = compiledNodes.get(id);
    if (!target) throw new Error(`node-as-tool: no node "${id}" in this graph.`);
    // Model-chosen arguments become the node's input (and a subgraph's input state).
    const toolArgs = withoutReservedKeys(args ?? {});
    const childCtx = {
      ...ctx,
      nodeId: id,
      _input: toolArgs,
      render(template: string, extra: Record<string, unknown> = {}) {
        const issues = (state[ISSUES_CHANNEL] as RunIssue[] | undefined) ?? [];
        return renderDeep(template, { state, input: toolArgs, config: ctx.config, run: ctx.meta, issues, ...extra });
      },
      issue(input: IssueInput) {
        const targetType = spec.nodes.find((n) => n.id === id)?.type;
        return ctx.issue({
          ...input,
          nodeId: input.nodeId ?? id,
          ...(targetType && !input.nodeType ? { nodeType: targetType } : {}),
        });
      },
    } as typeof ctx & { _input: Record<string, unknown> };
    const res = await target.run(state, childCtx);
    const update = resultToUpdate(res);
    const outputs = update[OUTPUTS_CHANNEL];
    if (
      outputs != null &&
      typeof outputs === "object" &&
      !Array.isArray(outputs) &&
      id in (outputs as Record<string, unknown>)
    ) {
      return (outputs as Record<string, unknown>)[id];
    }
    return update;
  };

  toolWiring.resolveToolMeta = (id) => {
    const ns = spec.nodes.find((n) => n.id === id);
    if (!ns) return undefined;
    const out: { description?: string; schema?: Record<string, unknown> } = {};
    if (ns.description) out.description = ns.description;
    if (ns.toolInput) out.schema = ns.toolInput as Record<string, unknown>;
    return Object.keys(out).length ? out : undefined;
  };

  // Edges. Router nodes drive exclusive routing via Command{ goto } + `ends`
  // declared from with.routes — skip their static/branch edges so a UI fan-out
  // (`to: [a, b]`) cannot race with the router's decision and run both branches.
  const routerIds = new Set(spec.nodes.filter(declaresRoutes).map((n) => n.id));
  for (const node of spec.nodes) {
    if (recoveryTargets(spec, node, opts.hooks).length === 0) continue;
    routerIds.add(node.id);
    graph.addConditionalEdges((mapJoinById.get(node.id) ?? node.id) as typeof START, (state: Record<string, unknown>) => {
      const selected = (state[ROUTING_CHANNEL] as Record<string, string | string[] | null> | undefined)?.[node.id];
      const targets = selected == null ? normalTargets(spec, node.id, state) : Array.isArray(selected) ? selected : [selected];
      return targets.map(to => to === "END" ? END : to);
    }, Object.fromEntries([...spec.nodes.map(n => n.id), END].map(id => [id, id])) as Record<string, typeof END>);
  }
  for (const edge of spec.edges) {
    if (routerIds.has(edge.from)) continue;
    let from = edge.from === "START" ? START : edge.from;
    if (typeof from === "string" && mapJoinById.has(from)) from = mapJoinById.get(from)!;
    if ("to" in edge) {
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
      for (const t of tos) graph.addEdge(from as typeof START, (t === "END" ? END : t) as typeof END);
    } else if ("branch" in edge) {
      const branches = edge.branch;
      graph.addConditionalEdges(from as typeof START, (state: Record<string, unknown>) => {
        for (const b of branches) {
          if (b.default) continue;
          if (b.when) {
            const expr = b.when.replace(/^\s*\{\{|\}\}\s*$/g, "").trim();
            try { if (evalGuard(expr, { state })) return b.to; } catch { continue; }
          }
        }
        return branches.find((b) => b.default)?.to ?? "END";
      });
    }
  }

  // Warn when parallel fan-out branches target the same lastWrite channel.
  warnFanInLastWrite(spec, createLogger(events, spec.metadata.name));

  // Checkpointer + store
  const checkpointer = resolveCheckpointer(spec, opts);

  const compileOpts: Record<string, unknown> = {};
  if (checkpointer) compileOpts["checkpointer"] = checkpointer;
  if (store) compileOpts["store"] = store;
  const interruptBefore = [...(spec.runtime?.hitl?.breakpoints?.before ?? []), ...(opts.interruptBefore ?? [])];
  const interruptAfter = [...(spec.runtime?.hitl?.breakpoints?.after ?? []), ...(opts.interruptAfter ?? [])];
  if (interruptBefore.length) compileOpts["interruptBefore"] = interruptBefore;
  if (interruptAfter.length) compileOpts["interruptAfter"] = interruptAfter;
  const compiledLg = graph.compile(compileOpts as Parameters<typeof graph.compile>[0]);

  const defaultPolicy: InterruptPolicy = spec.runtime?.hitl?.onInterrupt ?? "fail";

  return {
    spec,
    runId,
    events,
    compiledLg,
    checkpointer,
    hooks,
    baseCtx,
    graphDir,
    interruptBefore,
    interruptAfter,
    defaultPolicy,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPauseInterrupt(interrupts: InterruptInfo[]): boolean {
  if (interrupts.length === 0) return false;
  return interrupts.every((i) => {
    const value = i.payload as { reason?: string; __flowgraphPause?: boolean } | undefined;
    return (
      value?.__flowgraphPause === true ||
      value?.reason === "paused" ||
      i.reason === "paused"
    );
  });
}

function earliestDeadlineMs(interrupts: InterruptInfo[]): number | undefined {
  let earliest: number | undefined;
  for (const info of interrupts) {
    if (!info.deadlineAt) continue;
    const t = Date.parse(info.deadlineAt);
    if (Number.isNaN(t)) continue;
    if (earliest === undefined || t < earliest) earliest = t;
  }
  return earliest;
}

type WaitTimerMap = Map<string, ReturnType<typeof setTimeout>>;

function clearWaitTimeoutTimer(waitTimeoutTimers: WaitTimerMap, threadId: string): void {
  const timer = waitTimeoutTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    waitTimeoutTimers.delete(threadId);
  }
}

function scheduleWaitTimeoutTimer(
  waitTimeoutTimers: WaitTimerMap,
  threadId: string,
  interrupts: InterruptInfo[],
  onFire: () => void,
  now: () => number = Date.now,
  schedule: (fn: () => void, delayMs: number) => unknown = (fn, delayMs) => setTimeout(fn, delayMs),
): void {
  clearWaitTimeoutTimer(waitTimeoutTimers, threadId);
  const deadline = earliestDeadlineMs(interrupts);
  if (deadline === undefined) return;
  const delay = Math.max(0, deadline - now());
  const timer = schedule(() => {
    waitTimeoutTimers.delete(threadId);
    onFire();
  }, delay);
  (timer as { unref?: () => void } | undefined)?.unref?.();
  waitTimeoutTimers.set(threadId, timer as ReturnType<typeof setTimeout>);
}

function namespacedRunnableConfig(
  lgConfig: LangGraphRunnableConfig | undefined,
  itemId: string,
): LangGraphRunnableConfig | undefined {
  if (!lgConfig) return undefined;
  const prev = (lgConfig.configurable ?? {}) as Record<string, unknown>;
  const prevNs = typeof prev["checkpoint_ns"] === "string" ? prev["checkpoint_ns"] : "";
  return {
    ...lgConfig,
    configurable: {
      ...prev,
      checkpoint_ns: prevNs ? `${prevNs}|${itemId}` : itemId,
    },
  };
}

function buildInvokeConfig(
  threadId: string,
  spec: GraphSpec,
  checkpointId?: string,
): Record<string, unknown> {
  const recursionLimit = spec.runtime?.recursionLimit ?? 1000;
  return {
    configurable: {
      thread_id: threadId,
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    },
    ...(recursionLimit ? { recursionLimit } : {}),
  };
}

function memoryCheckpointer(spec: GraphSpec, opts: CompileOptions): BaseCheckpointSaver {
  return new FlowgraphMemorySaver(
    resolveCheckpointRetention(spec.runtime?.checkpoint?.retention, opts.checkpointRetention),
  );
}

function resolveCheckpointer(spec: GraphSpec, opts: CompileOptions): BaseCheckpointSaver | undefined {
  // Explicit object instance wins
  if (opts.checkpointer && typeof opts.checkpointer === "object") {
    return opts.checkpointer;
  }
  const enabled = spec.runtime?.checkpoint?.enabled !== false;
  if (!enabled) return undefined;
  if (opts.checkpointer === "none") return undefined;
  // An explicit caller choice of "memory" (tests, ephemeral runs) is not a silent fallback.
  if (opts.checkpointer === "memory") return memoryCheckpointer(spec, opts);

  const backend = spec.runtime?.checkpoint?.backend ?? "memory";
  if (backend === "memory") return memoryCheckpointer(spec, opts);
  if (backend === "postgres" || backend === "sqlite") {
    throw new Error(
      `runtime.checkpoint.backend "${backend}" requires passing a checkpointer instance to compileGraph ` +
        `(the CLI wires sqlite/postgres from runtime.checkpoint.path / DATABASE_URL). ` +
        `Silent in-memory fallback is not allowed.`,
    );
  }
  throw new Error(`Unknown checkpoint backend "${String(backend)}".`);
}

/** Host-provided memory for `CompileOptions.memory`. */
export interface MemoryHostOptions {
  backend: MemoryBackend;
  /** Org/project/user for scope tuples. Default org "local", project "local", no user. */
  identity?: MemoryIdentity | undefined;
}

function memoryUnavailable(what: string, checkpoint: string | undefined, hostHint?: string): MemoryError {
  const tail =
    `Silent in-memory fallback is not allowed — use runtime.memory.backend: memory for an ephemeral store in tests.`;
  if (hostHint) {
    return new MemoryError("MEMORY_BACKEND_UNAVAILABLE", `${what} needs a durable memory backend, and this host has none configured. ${hostHint} ${tail}`);
  }
  if (checkpoint === "sqlite" || checkpoint === "postgres") {
    // The graph already has a durable checkpointer; what's missing is a host-provided memory backend.
    const hint =
      checkpoint === "postgres"
        ? `Run it with the flowgraph CLI (memory then lives in the checkpoint database), or pass CompileOptions.memory ` +
          `(e.g. openPostgresBackend(url).memory from @flowgraph/checkpoint-postgres). `
        : `Run it with the flowgraph CLI (memory then lives in the checkpoint database), or pass CompileOptions.memory ` +
          `(e.g. openSqliteBackend(path).memory from @flowgraph/checkpoint-sqlite). `;
    return new MemoryError(
      "MEMORY_BACKEND_UNAVAILABLE",
      `${what} needs a memory backend for its ${checkpoint} checkpointer, and this host provided none. ${hint}${tail}`,
    );
  }
  return new MemoryError(
    "MEMORY_BACKEND_UNAVAILABLE",
    `${what} needs a durable checkpointer; set runtime.checkpoint.backend: sqlite ` +
      `(the CLI then stores memory in the checkpoint database), or pass CompileOptions.memory. ${tail}`,
  );
}

/**
 * Resolve the memory runtime and the legacy `ctx.store` for a compile.
 *
 * ctx.store: an injected BaseStore instance wins (documented as unscoped);
 * otherwise a graph-scoped adapter over the memory runtime's backend.
 * ctx.memory: only when runtime.memory is declared (or runtime.store names a
 * durable backend, which is an alias for runtime.memory.backend: checkpoint).
 */
function resolveMemory(
  spec: GraphSpec,
  opts: CompileOptions,
): { runtime: MemoryRuntime | undefined; store: BaseStore | undefined } {
  const memCfg = spec.runtime?.memory as RuntimeMemoryConfig | undefined;
  const storeCfg = spec.runtime?.store;
  const storeEnabled = storeCfg?.enabled !== false;
  const storeBackend: string = storeCfg?.backend ?? "memory";
  if (memCfg && storeCfg) {
    throw new MemoryError(
      "MEMORY_STORE_AND_MEMORY",
      "runtime.store and runtime.memory are mutually exclusive; move to runtime.memory (ctx.store keeps working on top of it)",
    );
  }
  if (!["memory", "none", "sqlite", "postgres"].includes(storeBackend)) {
    throw new MemoryError("MEMORY_BACKEND_UNKNOWN", `Unknown store backend "${storeBackend}". Expected memory | none | sqlite | postgres.`);
  }
  const storeAlias =
    storeEnabled && opts.store !== "none" && (storeBackend === "sqlite" || storeBackend === "postgres");
  const exposeMemory = !!memCfg || storeAlias;
  const injectedStore = opts.store && typeof opts.store === "object" ? opts.store : undefined;

  let runtime: MemoryRuntime | undefined;
  const m = opts.memory;
  if (m instanceof MemoryRuntime) {
    // Embedded subgraph: share the root graph's runtime (scopes, bindings, backend).
    runtime = m;
  } else {
    const ephemeralOk = m === "ephemeral" || opts.store === "memory";
    const host: MemoryHostOptions | undefined =
      m && typeof m === "object" ? ("backend" in m ? (m as MemoryHostOptions) : { backend: m as MemoryBackend }) : undefined;
    const graph = spec.metadata.name;
    const wantsDurable = memCfg ? (memCfg.backend ?? "checkpoint") === "checkpoint" : storeAlias;
    const fallbackIdentity = opts.memoryIdentity ?? LOCAL_MEMORY_IDENTITY;
    const ephemeral = () =>
      createEphemeralMemoryRuntime(graph, { config: memCfg, exposeMemory, identity: host?.identity ?? fallbackIdentity });
    if (memCfg?.backend === "memory") {
      runtime = ephemeral();
    } else if (host && exposeMemory) {
      // Only graphs that opt into durable memory (runtime.memory, or
      // runtime.store.backend sqlite|postgres) land in the host backend; a
      // plain graph keeps its process-local ctx.store as before.
      runtime = new MemoryRuntime({
        backend: host.backend,
        identity: host.identity ?? fallbackIdentity,
        graph,
        config: memCfg,
        exposeMemory,
      });
    } else if (wantsDurable && !ephemeralOk) {
      if (storeAlias && injectedStore) {
        // Programmatic host injected a raw BaseStore for runtime.store: sqlite|postgres.
        runtime = undefined;
      } else {
        const ck = spec.runtime?.checkpoint;
        const ckBackend = ck && ck.enabled !== false ? (ck.backend ?? "memory") : undefined;
        throw memoryUnavailable(memCfg ? "runtime.memory" : `runtime.store.backend "${storeBackend}"`, ckBackend, opts.memoryUnavailableHint);
      }
    } else if (opts.legacyStoreBackend && !exposeMemory) {
      runtime = new MemoryRuntime({
        backend: opts.legacyStoreBackend,
        identity: host?.identity ?? fallbackIdentity,
        graph,
        config: memCfg,
        exposeMemory: false,
      });
    } else {
      runtime = ephemeral();
    }
  }

  let store: BaseStore | undefined;
  if (injectedStore) store = injectedStore;
  else if (!storeEnabled || opts.store === "none" || storeBackend === "none") store = undefined;
  else store = runtime?.legacyStore();
  return { runtime, store };
}

/** Reserved channels each node type writes itself; every other node's write to them is dropped. */
const OWNED_RESERVED: Readonly<Record<string, readonly string[]>> = {
  service: [SERVICES_CHANNEL],
  worktree: [WORKTREES_CHANNEL],
};
const ENGINE_CHANNELS: ReadonlySet<string> = new Set([...RESERVED_STATE_CHANNELS, "__interrupt__"]);

/**
 * Drop reserved channels from a node's update unless its type owns them
 * (service → `__services`, worktree → `__worktrees`).
 * Engine channels are always dropped otherwise, so a function, router,
 * subgraph merge or output mapping can never plant service commands,
 * worktree paths or replayed tool results. Under a policy, every other `__`
 * name is dropped too.
 */
function dropUnownedReserved(
  update: Record<string, unknown>,
  nodeType: string,
  policy: NodePolicy | undefined,
): Record<string, unknown> {
  const owned = OWNED_RESERVED[nodeType] ?? [];
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(update)) {
    if (!isReservedChannel(k) || owned.includes(k)) continue;
    if (!ENGINE_CHANNELS.has(k) && !policy) continue;
    out ??= { ...update };
    delete out[k];
  }
  return out ?? update;
}

/**
 * A node decided `remote` (ADR-0020). A `subgraph` keeps its own run(): it reads `BuildContext.remote`
 * and swaps only the child invocation, so input seeding and merge-back are the in-process ones.
 * Any other node runs as a one-node child graph; its `outputs.<id>` is taken as the node's result
 * and its own `output` mapping (auto-save, `to`, `map`) is applied here, as the node would in-process.
 */
function placeRemotely(
  built: ReturnType<NodeFactory["build"]>,
  nodeSpec: NodeSpec,
  config: unknown,
  remote: RemoteNodeExecutor,
): ReturnType<NodeFactory["build"]> {
  // A timeout aborts the attempt's signal; the executor then cancels the child.
  const capabilities = { ...built.capabilities, stopsOnTimeout: true };
  if (nodeSpec.type === "subgraph") return { ...built, capabilities };
  return {
    ...built,
    capabilities,
    async run(state, ctx) {
      const input = (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {};
      // `execute` stages the artifacts in `input` to the worker; the node's output is fetched back
      // (ADR-0020 section 10), and only that: other files the child wrote stay on the worker.
      const final = await remote.execute({ ctx, spec: wrapperSpecForNode(nodeSpec, input), input, wrapper: true });
      const outputs = final["outputs"];
      const returned = outputs != null && typeof outputs === "object" ? (outputs as Record<string, unknown>)[nodeSpec.id] : undefined;
      const raw = await remote.stageOut(ctx, returned);
      const scope = { state, input, config: ctx.config, run: ctx.meta };
      return { update: applyOutput((config as { output?: OutputMapping } | undefined)?.output, raw, { nodeId: nodeSpec.id, scope }) };
    },
  };
}

function resultToUpdate(result: NodeResult): Record<string, unknown> {
  if ("update" in result) return result.update;
  if ("command" in result) return result.command.update ?? {};
  if ("interrupt" in result) throw new Error(`HITL interrupt: ${result.interrupt.reason}`);
  return {};
}

/** Collect Command.goto destinations declared on a router node's `with.routes`. */
/** A router, or a `hitl` that routes on the human's answer (`with.routes`). */
function declaresRoutes(nodeSpec: { type: string; with?: unknown }): boolean {
  if (nodeSpec.type === "router") return true;
  if (nodeSpec.type !== "hitl") return false;
  return hitlRouteTargets((nodeSpec.with ?? {}) as Record<string, unknown>).length > 0;
}

function collectRouteEnds(nodeSpec: { type: string; with?: unknown }): string[] {
  if (nodeSpec.type === "hitl") {
    return hitlRouteTargets((nodeSpec.with ?? {}) as Record<string, unknown>).map((to) =>
      to === "END" ? END : to,
    );
  }
  if (nodeSpec.type !== "router") return [];
  const withBlock = (nodeSpec.with ?? {}) as Record<string, unknown>;
  const routes = withBlock["routes"];
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return [];
  const ends = new Set<string>();
  for (const raw of Object.values(routes as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const to = (raw as Record<string, unknown>)["to"];
    if (typeof to === "string" && to.trim()) {
      ends.add(to === "END" ? END : to);
    }
  }
  return [...ends];
}

function isInterruptLike(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  return name === "GraphInterrupt" || name === "NodeInterrupt" || "lg_interrupt" in err;
}

function isAbortFailure(err: unknown, signal?: AbortSignal): boolean {
  if (isInterruptLike(err)) return false;
  if (signal?.aborted) return true;
  if (err != null && typeof err === "object") {
    const name = (err as { name?: string }).name ?? "";
    if (name === "AbortError") return true;
  }
  return false;
}

const INTERRUPT_ID = /^[0-9a-f]{32}$/;

function interruptIds(pending: ReadonlyArray<{ id?: string }>): string[] {
  return pending.map((it) => it.id ?? "").filter((id) => INTERRUPT_ID.test(id));
}

/** True when every key is a pending 32-hex interrupt id. */
function isKeyedResumeMap(value: unknown, pending: ReadonlyArray<{ id?: string }>): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as object);
  if (keys.length === 0) return false;
  const ids = new Set(interruptIds(pending));
  return keys.every((key) => ids.has(key));
}

function resumeValueRequiredError(threadId: string): Error & { code: "RESUME_VALUE_REQUIRED" } {
  const err = new Error(
    `resume() on thread "${threadId}" needs a value for its pending interrupt; pass resume: false or null to deny.`,
  ) as Error & { code: "RESUME_VALUE_REQUIRED" };
  err.code = "RESUME_VALUE_REQUIRED";
  return err;
}

function resumeMapRequiredError(threadId: string, count: number): Error & { code: "RESUME_MAP_REQUIRED" } {
  const err = new Error(
    `resume() on thread "${threadId}" has ${count} pending interrupts; pass a map keyed by interrupt id, for example { "<id>": value }.`,
  ) as Error & { code: "RESUME_MAP_REQUIRED" };
  err.code = "RESUME_MAP_REQUIRED";
  return err;
}

function resumeUnknownKeysError(threadId: string, keys: string[]): Error & { code: "RESUME_MAP_REQUIRED" } {
  const listed = keys.map((key) => JSON.stringify(key)).join(", ");
  const err = new Error(
    `resume() on thread "${threadId}" has unknown or extra interrupt id(s): ${listed}.`,
  ) as Error & { code: "RESUME_MAP_REQUIRED" };
  err.code = "RESUME_MAP_REQUIRED";
  return err;
}

/** Keys of a resume map that are not pending interrupt ids, when the value looks keyed. */
function unknownResumeKeys(value: unknown, pending: ReadonlyArray<{ id?: string }>): string[] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as object);
  if (!keys.some((key) => INTERRUPT_ID.test(key))) return undefined;
  const ids = new Set(interruptIds(pending));
  return keys.filter((key) => !ids.has(key));
}

/**
 * Throw when `value` cannot resume the pending interrupts (a missing value,
 * a truthy unkeyed answer with several gates, or unknown / extra keys).
 */
export function assertResumeValue(
  value: unknown,
  pending: ReadonlyArray<{ id?: string }>,
  threadId: string,
): void {
  if (value === undefined && interruptIds(pending).length > 0) throw resumeValueRequiredError(threadId);
  resumeCommand(value, pending, threadId);
}

/** Overdue interrupts take the timeout; the caller's answers for the rest are kept. */
function mergeTimeoutResume(
  payload: Record<string, unknown> | Command | null,
  expired: Command,
): Command {
  const overdue = (expired.resume && typeof expired.resume === "object" && !Array.isArray(expired.resume)
    ? (expired.resume as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const caller =
    payload instanceof Command && payload.resume && typeof payload.resume === "object" && !Array.isArray(payload.resume)
      ? (payload.resume as Record<string, unknown>)
      : {};
  return new Command({ resume: { ...caller, ...overdue } });
}

/**
 * The interrupt ids a resume Command will answer: the keys of a keyed map, or
 * every pending id when the value is a single unkeyed answer.
 */
function resumeAnswerIds(
  payload: Record<string, unknown> | Command | null,
  pending: ReadonlyArray<{ id?: string }>,
): string[] {
  if (!(payload instanceof Command)) return [];
  const value = payload.resume;
  if (isKeyedResumeMap(value, pending)) return Object.keys(value);
  return interruptIds(pending);
}

/**
 * Resume the pending interrupts with one answer. LangGraph drops a falsy
 * `resume` (`false`, `0`, `""`, `null`, `undefined`) as empty input, so a
 * falsy answer is sent per interrupt id instead, which it applies as given.
 * A truthy unkeyed value with several interrupts pending is refused so it
 * cannot be applied to every gate.
 */
function resumeCommand(value: unknown, pending: ReadonlyArray<{ id?: string }>, threadId: string): Command {
  const unknown = unknownResumeKeys(value, pending);
  if (unknown && unknown.length > 0) throw resumeUnknownKeysError(threadId, unknown);
  if (isKeyedResumeMap(value, pending)) return new Command({ resume: value });
  const ids = interruptIds(pending);
  if (ids.length > 1 && value) throw resumeMapRequiredError(threadId, ids.length);
  if (value) return new Command({ resume: value });
  if (ids.length > 0) {
    return new Command({ resume: Object.fromEntries(ids.map((id) => [id, value])) });
  }
  return new Command({ resume: value });
}

function extractInterrupts(result: Record<string, unknown>): InterruptInfo[] {
  const raw = result["__interrupt__"];
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => toInterruptInfo(it as { id: string; value?: unknown }));
}

function toInterruptInfo(it: { id?: string; value?: unknown }): InterruptInfo {
  const value = it.value as
    | {
        reason?: string;
        kind?: InterruptInfo["kind"];
        data?: { choices?: string[]; deadlineAt?: string };
        deadlineAt?: string;
      }
    | undefined;
  const info: InterruptInfo = { id: it.id ?? "", payload: it.value, kind: "approval" };
  if (value && typeof value === "object") {
    if (typeof value.reason === "string") info.reason = value.reason;
    if (value.kind) info.kind = value.kind;
    const choices = value.data?.choices;
    if (Array.isArray(choices) && choices.length > 0) info.choices = choices;
    const deadline = value.data?.deadlineAt ?? value.deadlineAt;
    if (typeof deadline === "string") info.deadlineAt = deadline;
    const v = resumeValidationInfo(value);
    if (v) {
      info.validationError = v.validationError;
      info.attempt = v.attempt;
      info.maxAttempts = v.maxAttempts;
      if (v.exhausted) info.exhausted = true;
    }
  }
  return info;
}

function isWebhookInterrupt(info: InterruptInfo): boolean {
  const payload = info.payload as { data?: { mode?: string } } | undefined;
  return payload?.data?.mode === "webhook";
}

function webhookNodeIdFromInterrupt(info: InterruptInfo): string | undefined {
  const payload = info.payload as { data?: { __nodeId?: string } } | undefined;
  const tagged = payload?.data?.__nodeId;
  if (typeof tagged === "string" && tagged) return tagged;
  // Fall back to interrupt id when it looks like a node id (LangGraph often uses the node id).
  if (info.id && !info.id.includes(":")) return info.id;
  return undefined;
}

function setWebhookUrlOnInterrupt(info: InterruptInfo, url: string): void {
  const payload = info.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const obj = payload as Record<string, unknown>;
  const existing = obj["data"];
  const data =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  data["webhookUrl"] = url;
  obj["data"] = data;
}

/** Reattach listening URLs from the in-process route registry (e.g. getState). */
function enrichInterruptsWithWebhookUrls(interrupts: InterruptInfo[], threadId: string): void {
  for (const info of interrupts) {
    if (!isWebhookInterrupt(info)) continue;
    const route = getWebhookRoute(threadId, webhookNodeIdFromInterrupt(info), info.id);
    if (route?.url) setWebhookUrlOnInterrupt(info, route.url);
  }
}

async function attachWebhookUrls(
  interrupts: InterruptInfo[],
  opts: {
    threadId: string;
    graphSpec: GraphSpec;
    executeInvoke: (
      payload: Record<string, unknown> | Command | null,
      runOpts: RunOptions | ResumeOptions | ContinueOptions,
      mode: ExecuteMode,
      overrides?: InvokeOverrides,
    ) => Promise<RunResult>;
    signal?: AbortSignal;
    sinks?: EventSink[];
    nodePolicy?: NodePolicy | undefined;
  },
): Promise<void> {
  // Never listen on a host port for a graph whose policy refuses inbound webhooks.
  if (opts.nodePolicy?.blockInboundWebhooks) return;
  const webhookInterrupts = interrupts.filter(isWebhookInterrupt);
  if (webhookInterrupts.length === 0) return;

  const serverCfg = (opts.graphSpec.runtime as { webhookServer?: WebhookServerConfig } | undefined)
    ?.webhookServer;
  const info = await ensureWebhookServer(serverCfg);

  for (const interrupt of webhookInterrupts) {
    const nodeId = webhookNodeIdFromInterrupt(interrupt) ?? "unknown";
    const payload = interrupt.payload as { data?: { schema?: Record<string, unknown> } } | undefined;
    const schema = payload?.data?.schema;
    const existing = getWebhookRoute(opts.threadId, nodeId, interrupt.id);
    const url = existing?.url ?? buildWebhookUrl(info.host, info.port, opts.threadId, nodeId, interrupt.id);
    setWebhookUrlOnInterrupt(interrupt, url);
    if (existing) continue;

    const onAbort = () => unregisterWebhookRoute(opts.threadId);
    if (opts.signal) {
      if (opts.signal.aborted) {
        unregisterWebhookRoute(opts.threadId);
        continue;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    void registerWebhookRoute({
      threadId: opts.threadId,
      nodeId,
      interruptId: interrupt.id,
      url,
      ...(schema ? { schema } : {}),
      ...(serverCfg?.token ? { token: serverCfg.token } : {}),
      resume: async (body) => {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        const result = await opts.executeInvoke(
          new Command({ resume: { [interrupt.id]: body } }),
          {
            threadId: opts.threadId,
            resume: body,
            onInterrupt: "fail",
            ...(opts.sinks ? { sinks: opts.sinks } : {}),
          },
          "resume",
          { preserveWebhookRoutes: true },
        );
        return {
          status: result.status,
          ...(result.error ? { error: result.error.message } : {}),
        };
      },
    });
  }
}

function stripReserved(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (isReservedChannel(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Tear down non-keepAlive services (and optional worktrees) when a run reaches completed/error. */
/** @internal Exported for tests. */
export async function maybeTerminateServices(
  spec: GraphSpec,
  threadId: string,
  state?: Record<string, unknown>,
  policy?: NodePolicy,
): Promise<void> {
  const terminate = spec.runtime?.services?.terminateOnEnd ?? true;
  if (terminate) {
    try {
      await terminateThreadServices(threadId);
    } catch {
      /* best-effort cleanup — do not fail the run result */
    }
  }
  // `git worktree remove` on paths from state only where worktree nodes could have made them.
  if (spec.runtime?.worktrees?.cleanupOnEnd && hostExecAllowed(policy, "worktree")) {
    const entries = (state?.[WORKTREES_CHANNEL] as Array<{ path?: unknown; repo?: unknown }>) ?? [];
    await cleanupWorktrees(entries);
  }
}

function buildNodeCtx(
  nodeSpec: Record<string, unknown>,
  state: Record<string, unknown>,
  base: Partial<RunContext>,
  events: EventBus,
  workspace: string,
  attempt: number,
  inputOverride?: Record<string, unknown>,
  lgConfig?: LangGraphRunnableConfig,
) {
  // Embedded subgraphs have no run of their own: their nodes report the
  // top graph's run and thread (from the run scope in the invoke config).
  const runScope = runScopeOf(lgConfig);
  const meta = (runScope?.meta ?? base.meta) as RunMeta | undefined;
  const scope = { state, config: base.config ?? {}, run: meta ?? {} };
  // Rendered `input` and node:before replacements alike lose `__` keys.
  const _input = withoutReservedKeys(
    inputOverride
      ?? (nodeSpec["input"]
        ? (renderDeep(nodeSpec["input"] as Record<string, string>, scope) as Record<string, unknown>)
        : {}),
  );

  const nodeId = String(nodeSpec["id"]);
  const nodeType = String(nodeSpec["type"]);
  const onceState = (state[ONCE_CHANNEL] as Record<string, unknown> | undefined) ?? {};
  const _onceUpdates: Record<string, unknown> = {};
  const existingIssues = (state[ISSUES_CHANNEL] as RunIssue[] | undefined) ?? [];
  const _issueUpdates: RunIssue[] = [];
  const seenIssueKeys = new Set(existingIssues.map((i) => issueDedupeKey(i)));
  const parentSpanId = typeof nodeSpec["__parentSpanId"] === "string" ? nodeSpec["__parentSpanId"] : undefined;

  let resolvedWorkspace = workspace;
  const wsTpl = nodeSpec["workspace"];
  if (typeof wsTpl === "string" && wsTpl.trim()) {
    const rendered = String(renderDeep(wsTpl, { ...scope, input: _input }));
    resolvedWorkspace = path.isAbsolute(rendered) ? rendered : path.resolve(workspace, rendered);
  }

  const logger = (base as RunContext).logger ?? { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const ctx: NodeRunContext & {
    _input: Record<string, unknown>;
    _onceUpdates: Record<string, unknown>;
    _issueUpdates: RunIssue[];
    _lgConfig?: LangGraphRunnableConfig;
  } = {
    ...(base as RunContext),
    meta: (meta ?? { runId: "", graph: "", startedAt: "" }) as RunContext["meta"],
    secrets: base.secrets!,
    events,
    logger,
    workspace: resolvedWorkspace,
    nodeId,
    nodeType,
    attempt,
    _input,
    _onceUpdates,
    _issueUpdates,
    render(template: string, extra: Record<string, unknown> = {}) {
      const issues = [...existingIssues, ..._issueUpdates];
      return renderDeep(template, {
        state,
        input: _input,
        config: base.config,
        run: meta,
        issues,
        ...extra,
      });
    },
    emit(type, data) { events.emit(type, data, { nodeId, nodeType, ...(parentSpanId ? { parentSpanId } : {}) }); },
    interrupt<T = unknown>(payload: { reason: string; data?: unknown; kind?: import("./context.js").InterruptKind }): T {
      // `__` keys in interrupt data are the engine's (`__nodeId`, `__agentReplay`);
      // drop any the node or graph author put there before adding ours.
      const data =
        payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
          ? { ...withoutReservedKeys(payload.data as Record<string, unknown>), __nodeId: nodeId }
          : { ...(payload.data !== undefined ? { value: payload.data } : {}), __nodeId: nodeId };
      preserveInterruptDeadline(runScope, nodeId, data);
      const savedReplay = replayAttachment(runScope, nodeId);
      if (savedReplay) (data as Record<string, unknown>)["__agentReplay"] = savedReplay;
      const tagged = { ...payload, data };
      return lgInterrupt(tagged) as T;
    },
    async once<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
      const scopedKey = `${nodeId}:${key}`;
      if (scopedKey in onceState) return onceState[scopedKey] as T;
      const value = await fn();
      _onceUpdates[scopedKey] = value;
      return value;
    },
    issue(input: IssueInput): RunIssue {
      const stamped = stampIssue(input, { nodeId, nodeType });
      const key = issueDedupeKey(stamped);
      if (seenIssueKeys.has(key)) return stamped;
      seenIssueKeys.add(key);
      _issueUpdates.push(stamped);
      events.emit("run.issue", stamped, { nodeId, nodeType });
      try {
        appendRunIssue(
          resolvedWorkspace,
          runIssuesKey({
            ...(meta?.threadId ? { threadId: meta.threadId } : {}),
            ...(meta?.runId ? { runId: meta.runId } : {}),
          }),
          stamped,
        );
      } catch (err) {
        logger.warn("failed to append run issue", { reason: err instanceof Error ? err.message : String(err) });
      }
      return stamped;
    },
  };
  if (lgConfig !== undefined) ctx._lgConfig = lgConfig;
  const signal = runSignalOf(lgConfig, base.signal);
  if (signal !== undefined) ctx.signal = signal;
  else delete ctx.signal;
  const memoryRuntime = (base as Record<symbol, unknown>)[MEMORY_RUNTIME] as MemoryRuntime | undefined;
  if (memoryRuntime?.exposeMemory) {
    const conf = (lgConfig?.configurable ?? {}) as Record<string, unknown>;
    const threadId = typeof conf["thread_id"] === "string" ? conf["thread_id"] : meta?.threadId;
    const memory = memoryRuntime.memoryForConfig(lgConfig, nodeId, { runId: meta?.runId, threadId });
    if (memory) ctx.memory = memory;
  }
  return ctx;
}

export function resolveGraphWorkspace(spec: GraphSpec, graphDir: string): string {
  const raw = spec.runtime?.workspace;
  if (typeof raw !== "string" || !raw.trim()) return graphDir;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(graphDir, raw);
}

function overdueInterruptIds(snap: {
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ id?: string; value?: unknown }> }>;
} | null | undefined, now = Date.now()): string[] {
  if (!snap) return [];
  return (snap.tasks ?? []).flatMap((task) => task.interrupts ?? [])
    .filter((it) => {
      const deadline = toInterruptInfo(it).deadlineAt;
      return deadline !== undefined && Date.parse(deadline) <= now;
    })
    .map((it) => it.id)
    .filter((id): id is string => typeof id === "string" && INTERRUPT_ID.test(id));
}

/** A Command that times out only the interrupts whose deadline has passed. */
function timeoutResumeCommand(snap: {
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ id?: string; value?: unknown }> }>;
} | null | undefined, now = Date.now()): Command | undefined {
  const overdue = overdueInterruptIds(snap, now);
  if (overdue.length === 0) return undefined;
  return new Command({ resume: Object.fromEntries(overdue.map((id) => [id, { timedOut: true }])) });
}

/** Values of the pending interrupts in a thread snapshot (engine-written payloads). */
/**
 * The replay entries to attach to an interrupt raised by node `nodeId` in
 * the current execution: everything under the top-level node whose task is
 * running (the scope's root, or the node itself at the top level), since a
 * resume re-runs that whole task. That covers the node, the nodes it called
 * as tools, and the agents above it when it runs inside a node tool (a
 * subgraph, map item or hitl node reached through tool calls, at any depth).
 */
function replayAttachment(runScope: RunScope | undefined, nodeId: string): Record<string, unknown> | undefined {
  if (!runScope) return undefined;
  const at = replayNodeKey(runScope.path, nodeId);
  const root = runScope.root ?? at;
  const saved = runScope.replay.snapshotUnder(root);
  if (saved.length === 0) return undefined;
  const own = saved.find((s) => s.node === root);
  const nested = saved.filter((s) => s.node !== root);
  return {
    node: root,
    ...(at !== root ? { at } : {}),
    entries: own?.entries ?? {},
    ...(nested.length > 0 ? { nested } : {}),
  };
}

/**
 * Interrupt data for an interrupt the engine raises around a node (pause,
 * `node:before` hook): `data` unchanged unless entries must be saved (the
 * node runs below a top-level node, e.g. inside a subgraph called as an
 * agent tool), in which case they are attached as for `ctx.interrupt`.
 */
function withReplayData(data: unknown, runScope: RunScope | undefined, nodeId: string): unknown {
  const replay = replayAttachment(runScope, nodeId);
  if (!replay) return data;
  const base = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : data === undefined ? {} : { value: data };
  return { ...base, __nodeId: nodeId, __agentReplay: replay };
}

/**
 * Refuse a node id the engine's own keys could not tell apart from another
 * node: an id shaped like a map item (`m[0]`), or one with a comma, colon or
 * control character (replay keys, checkpoint namespaces and the keys saved by
 * earlier releases are built from ids with these). Specs loaded from YAML
 * already allow only letters, digits, `_` and `-`; this covers graphs built
 * in code.
 */
function assertReplaySafeNodeId(id: unknown): void {
  if (id === undefined) return;
  if (typeof id !== "string" || id === "") throw new Error(`Node id ${JSON.stringify(id)} must be a non-empty string.`);
  // eslint-disable-next-line no-control-regex
  if (/[,:\u0000-\u001f\u007f-\u009f]/.test(id) || /\[[0-9]+\]$/.test(id)) {
    throw new Error(
      `Node id ${JSON.stringify(id)} cannot contain ",", ":" or control characters or end in "[<number>]" (the form of a map item); use letters, digits, "_" and "-".`,
    );
  }
}

/** The Send index of a task LangGraph runs for a `Send` (`path` `["__pregel_push", n]`), or undefined. */
function pushIndexOf(task: { path?: ReadonlyArray<unknown> }): number | undefined {
  const path = task.path;
  if (!Array.isArray(path) || path.length !== 2 || path[0] !== "__pregel_push") return undefined;
  const index = path[1];
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * Pending interrupt values of a thread snapshot, with, per value, a check
 * that a node id is the top-level node of the task holding it: the task's
 * own node, or, for a map worker task, that task's own item. A map sends
 * all its items from one node in item order, so they are consecutive
 * `Send`s and an item's index is its task's Send index less the smallest
 * Send index of the same worker (other nodes' Sends in the same step come
 * before or after them). The snapshot lists every task of the step,
 * finished ones too, so that smallest index is the map's item 0.
 *
 * @internal Exported for tests.
 */
export function pendingInterrupts(snap: {
  tasks?: ReadonlyArray<{ name?: string; path?: ReadonlyArray<unknown>; interrupts?: ReadonlyArray<{ value?: unknown }> }>;
} | null | undefined): { values: unknown[]; taskRoots: Array<((nodeId: string) => boolean) | undefined> } {
  const values: unknown[] = [];
  const taskRoots: Array<((nodeId: string) => boolean) | undefined> = [];
  const firstSend = new Map<string, number>();
  for (const task of snap?.tasks ?? []) {
    const index = pushIndexOf(task);
    if (task.name && index !== undefined) firstSend.set(task.name, Math.min(firstSend.get(task.name) ?? index, index));
  }
  for (const task of snap?.tasks ?? []) {
    const name = task.name;
    const sendIndex = pushIndexOf(task);
    const itemIndex = name && sendIndex !== undefined ? sendIndex - firstSend.get(name)! : undefined;
    const isRoot = name
      ? (nodeId: string) => {
          if (nodeId === name) return true;
          const item = /^(.+)\[([0-9]+)\]$/.exec(nodeId);
          return item !== null && itemIndex !== undefined && item[2] === String(itemIndex) && mapSyntheticIds(item[1]!).workerId === name;
        }
      : undefined;
    for (const it of task.interrupts ?? []) {
      values.push(it.value);
      taskRoots.push(isRoot);
    }
  }
  return { values, taskRoots };
}

/** @internal Exported for tests. */
export async function hydrateDurableRuntime(
  snap: {
    values?: Record<string, unknown>;
    tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ id?: string; value?: unknown }> }>;
  } | null | undefined,
  threadId: string,
  graphSpec: GraphSpec,
  opts: {
    executeInvoke: (
      payload: Record<string, unknown> | Command | null,
      runOpts: RunOptions | ResumeOptions | ContinueOptions,
      mode: ExecuteMode,
      overrides?: InvokeOverrides,
    ) => Promise<RunResult>;
    signal?: AbortSignal;
    sinks?: EventSink[];
    rehydrateWebhooks?: boolean;
    nodePolicy?: NodePolicy | undefined;
  },
): Promise<void> {
  if (!snap) return;
  const interrupts: InterruptInfo[] = [];
  for (const task of snap.tasks ?? []) {
    for (const it of task.interrupts ?? []) interrupts.push(toInterruptInfo(it));
  }
  if (opts.rehydrateWebhooks !== false && interrupts.some(isWebhookInterrupt)) {
    await attachWebhookUrls(interrupts, {
      threadId,
      graphSpec,
      executeInvoke: opts.executeInvoke,
      nodePolicy: opts.nodePolicy,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.sinks ? { sinks: opts.sinks } : {}),
    });
  }

  if (graphSpec.runtime?.services?.rehydrateOnResume) {
    const intents = snap.values?.[SERVICES_CHANNEL];
    if (intents && typeof intents === "object") {
      for (const [name, raw] of Object.entries(intents as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const current = statusService(threadId, name);
        if (current.status === "running") continue;
        const spec = raw as ServiceStartSpec;
        try {
          // Saved state is not proof the graph may start programs: refuse
          // under a policy that blocks service nodes or host programs.
          assertNodeTypeAllowed(opts.nodePolicy, "service", `rehydrating service "${name}"`);
          assertHostExecAllowed(opts.nodePolicy, `service "${name}"`, `rehydrating service "${name}"`);
          await startService(threadId, { ...spec, name });
        } catch (err) {
          (raw as Record<string, unknown>)["needsRestart"] = true;
          (raw as Record<string, unknown>)["rehydrateError"] = err instanceof Error ? err.message : String(err);
        }
      }
    }
  }
}

function addCheckpointedMap(
  graph: StateGraph<unknown>,
  spec: GraphSpec,
  nodeSpec: NodeSpec,
  configUnknown: unknown,
  ctx: {
    runId: string;
    events: EventBus;
    baseCtx: Partial<RunContext>;
    graphWorkspace: string;
    hooks: HookBus;
    toolWiring: ToolWiring;
    defaultRetry: unknown;
    defaultTimeout: unknown;
    executionLimit: ExecutionLimit;
    externalHooks?: Hook[] | undefined;
  },
  mapJoinById: Map<string, string>,
): void {
  const parsed = MapWithSchema.safeParse(configUnknown);
  if (!parsed.success) {
    throw new Error(
      `Node "${nodeSpec.id}" config error: ` +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
    );
  }
  const config = parsed.data;
  const mapId = nodeSpec.id;
  const { workerId, joinId } = mapSyntheticIds(mapId);
  mapJoinById.set(mapId, joinId);

  const innerType = String((config.node as Record<string, unknown>)["type"] ?? "");
  const innerStopsOnTimeout = registry.get(innerType)?.capabilities?.stopsOnTimeout === true;
  const buildCtx = {
    graphName: spec.metadata.name,
    toolWiring: ctx.toolWiring,
    ...(spec.runtime?.worktrees?.root ? { worktreeRoot: spec.runtime.worktrees.root } : {}),
    ...(spec.runtime?.context ? { contextDefaults: spec.runtime.context } : {}),
  };
  const nodeRetry = ((config.node as Record<string, unknown>)["retry"] ?? nodeSpec.retry ?? ctx.defaultRetry) as RetryConfigInput;
  const nodeTimeout = ((config.node as Record<string, unknown>)["timeout"] ?? nodeSpec.timeout ?? ctx.defaultTimeout) as string | undefined;

  const mapLimit = createExecutionLimit(config.concurrency);

  const recover = async (err: unknown, state: Record<string, unknown>, itemId = mapId) => {
    if (isInterruptLike(err) || ctx.baseCtx.signal?.aborted) throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    const hook = await ctx.hooks.run("node:error", { state, run: ctx.baseCtx.meta as RunMeta, payload: { nodeId: mapId, nodeType: "map", error } });
    const innerPolicy = itemId === mapId ? undefined : (config.node as { on?: { error?: string } }).on?.error;
    const policy = hook.control?.kind === "route" ? `route:${hook.control.to}` : hook.control?.kind === "veto" ? "continue" : innerPolicy ?? nodeSpec.on?.error;
    ctx.events.emit("node.error", { nodeId: itemId, error: error.message, ...(policy && policy !== "fail" ? { swallowed: true, policy } : {}) }, { nodeId: itemId, nodeType: itemId === mapId ? "map" : innerType });
    if (!policy || policy === "fail") throw err;
    const issue = stampIssue({ code: "ERROR_SWALLOWED", severity: "warning", message: `map item/node "${itemId}" failed: ${error.message}`, impact: "Failed items have no collected value; admitted siblings finish before recovery." }, { nodeId: itemId, nodeType: innerType });
    return { [ISSUES_CHANNEL]: [issue], ...(policy.startsWith("route:") ? { [ROUTING_CHANNEL]: { [mapId]: policy.slice(6) } } : {}) };
  };

  graph.addNode(
    mapId,
    async (state: Record<string, unknown>) => {
      try {
      const scope = { state, config: ctx.baseCtx.config ?? {}, run: ctx.baseCtx.meta ?? {} };
      const collection = renderDeep(config.over, scope);
      if (!Array.isArray(collection)) {
        throw new Error(`map node "${mapId}": "over" did not evaluate to an array.`);
      }
      ctx.events.emit("node.start", { nodeId: mapId, type: "map" }, { nodeId: mapId, nodeType: "map" });
      ctx.events.emit("node.output", { map: { over: config.over, count: collection.length, concurrency: config.concurrency } }, { nodeId: mapId, nodeType: "map" });
      const round = randomUUID();
      const reset = { [MAP_COLLECT_CHANNEL]: { [mapId]: { round, items: [], reset: true } } };
      if (collection.length === 0) {
        const update = collectMapResults(config, [], mapId, scope);
        ctx.events.emit("node.end", { nodeId: mapId, update }, { nodeId: mapId, nodeType: "map" });
        return new Command({ goto: joinId, update: { ...update, ...reset, [ROUTING_CHANNEL]: { [mapId]: null } } }) as unknown as Record<string, unknown>;
      }
      return new Command({
        update: { ...reset, [ROUTING_CHANNEL]: { [mapId]: null } },
        goto: collection.map(
          (item, index) =>
            new Send(workerId, {
              ...state,
              [MAP_TASK_CHANNEL]: { mapId, index, item, as: config.as, count: collection.length, round } satisfies MapTask,
            }),
        ),
      }) as unknown as Record<string, unknown>;
      } catch (err) {
        const update = await recover(err, state);
        return new Command({ goto: joinId, update: { [MAP_COLLECT_CHANNEL]: { [mapId]: [] }, [ROUTING_CHANNEL]: { [mapId]: null }, ...update } }) as unknown as Record<string, unknown>;
      }
    },
    { ends: [workerId, joinId] } as Parameters<typeof graph.addNode>[2],
  );

  graph.addNode(workerId, async (state: Record<string, unknown>, lgConfig?: LangGraphRunnableConfig) => {
    const task = state[MAP_TASK_CHANNEL] as MapTask | undefined;
    if (!task || task.mapId !== mapId) {
      throw new Error(`map worker "${workerId}": missing __mapTask payload.`);
    }
    const itemId = `${mapId}[${task.index}]`;
    const itemScope = { nodeId: itemId, nodeType: innerType, parentSpanId: mapId };
    const itemLgConfig = namespacedRunnableConfig(lgConfig, itemId);

    try {
      const executeItem = () => runWithPolicy(
        (attempt, signal) => {
          const nodeCtx = buildNodeCtx(
            {
              ...(config.node as Record<string, unknown>),
              id: itemId,
              type: innerType,
              __parentSpanId: mapId,
            },
            state,
            ctx.baseCtx,
            ctx.events,
            ctx.graphWorkspace,
            attempt,
            undefined,
            itemLgConfig,
          );
          if (signal && innerStopsOnTimeout) nodeCtx.signal = signal;
          return runMapItem(buildCtx, mapId, config, state, nodeCtx, task).then((value) => {
            finishInterruptDeadline(runScopeOf(itemLgConfig), itemId);
            return { value, onceUpdates: nodeCtx._onceUpdates, issueUpdates: nodeCtx._issueUpdates };
          });
        },
        {
          retry: nodeRetry,
          timeout: nodeTimeout,
          signal: runSignalOf(lgConfig, ctx.baseCtx.signal),
          stopGraceMs: innerStopsOnTimeout ? TIMED_OUT_ATTEMPT_STOP_MS : 0,
          onRetry: (info) => ctx.events.emit("node.retry", { nodeId: itemId, ...info }, itemScope),
          onTimeout: (info) => ctx.events.emit("node.timeout", { nodeId: itemId, ...info }, itemScope),
        },
      );
      // Internal task cancellation can stop queued admission, but only caller
      // cancellation reaches an admitted node (media jobs survive node timeouts).
      const signal = lgConfig?.signal ?? runSignalOf(lgConfig, ctx.baseCtx.signal);
      const run = await mapLimit(() => ctx.executionLimit(() => {
        ctx.events.emit("node.start", { nodeId: itemId, type: innerType, mapId, index: task.index }, itemScope);
        return executeItem();
      }, lgConfig, signal), lgConfig, signal);
      ctx.events.emit("node.end", { nodeId: itemId, mapId, index: task.index }, itemScope);
      const update: Record<string, unknown> = {
        [MAP_COLLECT_CHANNEL]: { [mapId]: task.round ? { round: task.round, items: [{ i: task.index, v: run.value }] } : [{ i: task.index, v: run.value }] },
      };
      if (Object.keys(run.onceUpdates).length > 0) update[ONCE_CHANNEL] = run.onceUpdates;
      if (run.issueUpdates.length > 0) update[ISSUES_CHANNEL] = run.issueUpdates;
      return update;
    } catch (err) {
      return recover(err, state, itemId);
    }
  });

  graph.addNode(joinId, exclusiveRouting(mapId, recoveryTargets(spec, nodeSpec, ctx.externalHooks).length > 0, async (state: Record<string, unknown>) => {
    const bagRaw = (state[MAP_COLLECT_CHANNEL] as Record<string, unknown> | undefined)?.[mapId];
    const roundItems = (bagRaw as { items?: unknown } | undefined)?.items;
    const bag = (Array.isArray(bagRaw) ? bagRaw : Array.isArray(roundItems) ? roundItems : []) as Array<{ i: number; v: unknown }>;
    const scope = { state, config: ctx.baseCtx.config ?? {}, run: ctx.baseCtx.meta ?? {} };
    const update = collectMapResults(config, bag, mapId, scope);
    ctx.events.emit("node.end", { nodeId: mapId, update, joined: true }, { nodeId: mapId, nodeType: "map" });
    const to = (state[ROUTING_CHANNEL] as Record<string, string> | undefined)?.[mapId];
    if (to) return new Command({ goto: to, update }) as unknown as Record<string, unknown>;
    return update;
  }));

  graph.addEdge(workerId as typeof START, joinId as typeof END);
}
