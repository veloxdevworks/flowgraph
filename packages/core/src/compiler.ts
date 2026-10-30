/**
 * Stage 2: build a LangGraph StateGraph from a validated GraphSpec,
 * plus run/resume/inspect with durability, HITL, and retry/timeout.
 */

import { START, END, StateGraph, MemorySaver, Command, Send, type BaseCheckpointSaver, type BaseStore, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { interrupt as lgInterrupt } from "@langchain/langgraph";
import { resumeValidationInfo } from "./runtime/resume-validation.js";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { MapWithSchema } from "@flowgraph/spec";
import { evalGuard, renderDeep } from "@flowgraph/expr";
import { registry, type NodeFactory } from "./registry.js";
import { createEventBus, type EventBus, type EventSink, type FlowgraphEvent } from "./events.js";
import { createEnvSecretProvider } from "./secrets.js";
import {
  createLogger,
  type RunContext,
  type NodeRunContext,
  type RunConfig,
  type RunMeta,
} from "./context.js";
import type { NodeResult } from "./registry.js";
import { buildStateAnnotation, ONCE_CHANNEL, REPLAY_CHANNEL, MAP_COLLECT_CHANNEL, MAP_TASK_CHANNEL, SERVICES_CHANNEL, WORKTREES_CHANNEL, ISSUES_CHANNEL, RESERVED_STATE_CHANNELS } from "./runtime/state-annotation.js";
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
import { ensureDeclaredOutputChannels } from "./runtime/validate-graph.js";
import { warnFanInLastWrite } from "./runtime/fan-in-warning.js";
import { loadGraphImports } from "./runtime/load-imports.js";
import { runWithPolicy, type RetryConfig as RetryConfigInput } from "./runtime/retry.js";
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
import { clearThreadReplayCache, hydrateReplay, hydrateReplayFromInterruptPayload, replayCacheKey, snapshotReplay } from "./providers/replay-cache.js";
import { collectMapResults, mapSyntheticIds, runMapItem, type MapTask } from "./nodes/map.js";
import type { ToolWiring } from "./providers/tools.js";
import type { BudgetState } from "./context.js";
import type { McpHub } from "./mcp/types.js";
import { createHookBus, type HookBus } from "./hooks/bus.js";
import type { Hook } from "./hooks/types.js";
import { hooksFromSpec, defaultGuardrailHooks } from "./hooks/builtin.js";
import "./nodes/index.js";
import { MemoryRuntime, MEMORY_RUNTIME, createEphemeralMemoryRuntime, LOCAL_MEMORY_IDENTITY, type RuntimeMemoryConfig } from "./memory/runtime.js";
import { MemoryError, type MemoryBackend, type MemoryIdentity } from "./memory/types.js";

export type InterruptPolicy = "prompt" | "fail" | "approve" | "webhook";

export interface CompileOptions {
  cwd?: string;
  /** Graph file path — `imports` specifiers resolve relative to this file's directory. */
  graphPath?: string;
  sinks?: EventSink[];
  runConfig?: RunConfig;
  checkpointer?: "memory" | "none" | BaseCheckpointSaver;
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
  extraFactories?: NodeFactory[];
  providers?: ProviderAdapter[];
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
   * Graceful pause: after the current node completes, stop and return
   * `status: "paused"` so the thread can later be resumed via `continueRun`.
   * Distinct from `signal`, which hard-cancels (not resumable).
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
  getState(threadId: string): Promise<StateSnapshot | null>;
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
}

type ExecuteMode = "start" | "resume" | "continue";

/** Per-invocation execution options (never written back to the shared spec). */
interface InvokeOverrides {
  /** Stop after one superstep (LangGraph invoke-time `interruptAfter: "*"`). */
  singleStep?: boolean;
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
  const assembled = await assembleCompiledLangGraph(spec, opts);
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

  // Per compiled graph: two graphs that reuse a thread id must not cancel each other's timers.
  const waitTimers: WaitTimerMap = new Map();

  const executeInvoke = async (
    payload: Record<string, unknown> | Command | null,
    runOpts: RunOptions | ResumeOptions | ContinueOptions,
    mode: ExecuteMode,
    overrides: InvokeOverrides = {},
  ): Promise<RunResult> => {
    const startMs = Date.now();
    const threadId = runOpts.threadId ?? `thread-${runId}`;
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
    const finish = (r: RunResult): RunResult => {
      try {
        const issues = readRunIssues(workspace, runIssuesKey({ threadId, runId }));
        if (issues.length > 0) r.issues = issues;
      } catch {
        /* ignore unreadable issue logs */
      }
      return r;
    };

    // CLI/IPC resume should drop any in-process HTTP listener for this thread.
    if (mode === "resume") {
      unregisterWebhookRoute(threadId);
    }

    // A fresh start must not replay agent LLM/tool results left behind by an
    // interrupted run on the same thread that was never resumed.
    if (mode === "start") {
      clearThreadReplayCache(threadId);
    } else if (checkpointer) {
      const snap = await compiledLg.getState(cfg);
      await hydrateDurableRuntime(snap, threadId, graphSpec, {
        executeInvoke,
        rehydrateWebhooks: mode !== "resume",
        ...(runOpts.signal ? { signal: runOpts.signal } : {}),
        ...(runOpts.sinks ? { sinks: runOpts.sinks } : {}),
      });
      const expired = expiredWaitResume(snap);
      if (expired) {
        payload = new Command({ resume: expired });
        mode = "resume";
      }
    }

    const startEvent =
      mode === "resume" ? "interrupt.resumed" : mode === "continue" ? "run.continued" : "run.start";
    events.emit(startEvent, {
      graphName: graphSpec.metadata.name,
    });

    try {
      let current: Record<string, unknown> | Command | null = payload;

      if (mode === "start" && current != null && !(current instanceof Command) && hooks.has("run:before")) {
        const r = await hooks.run("run:before", {
          state: current,
          run: runMeta,
          payload: { input: current as Record<string, unknown> },
        });
        if (r.payload.input) current = r.payload.input;
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
            events.emit("run.paused", { state: clean, next: [...snap.next], step: true, durationMs: Date.now() - startMs });
            return finish({ status: "paused", state: clean, runId, threadId, durationMs: Date.now() - startMs });
          }
        }

        if (interrupts.length === 0) {
          if (checkpointer && (interruptBefore.length || interruptAfter.length)) {
            const snap = await compiledLg.getState(cfg);
            if (snap && Array.isArray(snap.next) && snap.next.length > 0) {
              const clean = stripReserved(result);
              const bp: InterruptInfo[] = [{ id: `breakpoint:${snap.next.join(",")}`, reason: `Paused before: ${snap.next.join(", ")}` }];
              events.emit("interrupt.raised", { interrupts: bp });
              if (policy === "fail" || policy === "webhook" || !runOpts.resolveInterrupt) {
                return finish({ status: "interrupted", state: clean, runId, threadId, interrupts: bp, durationMs: Date.now() - startMs });
              }
              await runOpts.resolveInterrupt(bp);
              current = new Command({ resume: null });
              continue;
            }
          }
          const clean = stripReserved(result);
          if (hooks.has("run:after")) {
            await hooks.run("run:after", { state: clean, run: runMeta, payload: { update: clean } });
          }
          events.emit("run.end", { state: clean, durationMs: Date.now() - startMs });
          await maybeTerminateServices(graphSpec, threadId, result);
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
          ...(runOpts.signal ? { signal: runOpts.signal } : {}),
          ...(runOpts.sinks ? { sinks: runOpts.sinks } : {}),
        });

        events.emit("interrupt.raised", { interrupts });

        if (policy === "fail" || policy === "webhook") {
          scheduleWaitTimeoutTimer(waitTimers, threadId, interrupts, () => {
            executeInvoke(
              new Command({ resume: { timedOut: true } }),
              { threadId, resume: { timedOut: true }, onInterrupt: "fail" },
              "resume",
            ).then(
              (timedOutResult) => {
                try {
                  opts.onWaitTimeout?.(timedOutResult);
                } catch (cbErr) {
                  const m = cbErr instanceof Error ? cbErr.message : String(cbErr);
                  events.emit("run.error", { message: `onWaitTimeout callback failed: ${m}`, error: m, threadId });
                }
              },
              (err: unknown) => {
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
          });
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
          resumeValue = await runOpts.resolveInterrupt(interrupts);
        } else if (policy === "approve") {
          resumeValue = true;
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
        current = new Command({ resume: resumeValue });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (isAbortFailure(err, runOpts.signal)) {
        events.emit("run.aborted", { message: error.message, error: error.message, durationMs: Date.now() - startMs });
        await maybeTerminateServices(graphSpec, threadId);
        return finish({ status: "aborted", state: {}, runId, threadId, error, durationMs: Date.now() - startMs });
      }
      if (hooks.has("run:error")) {
        try { await hooks.run("run:error", { state: {}, run: runMeta, payload: { error } }); } catch { /* ignore */ }
      }
      events.emit("run.error", { message: error.message, error: error.message, durationMs: Date.now() - startMs });
      await maybeTerminateServices(graphSpec, threadId);
      return finish({ status: "error", state: {}, runId, threadId, error, durationMs: Date.now() - startMs });
    } finally {
      delete (baseCtx as RunContext & { pauseSignal?: AbortSignal }).pauseSignal;
      for (const u of unsubs) u();
    }
  };

  const toSnapshot = (
    snap: { values: Record<string, unknown>; next: readonly string[]; config?: { configurable?: { checkpoint_id?: string } }; createdAt?: string; tasks?: ReadonlyArray<{ name?: string; interrupts?: ReadonlyArray<{ id?: string; value?: unknown }> }> },
    threadId?: string,
  ): StateSnapshot => {
    const interrupts: InterruptInfo[] = [];
    const next = [...snap.next];
    for (const task of snap.tasks ?? []) {
      for (const it of task.interrupts ?? []) {
        interrupts.push(toInterruptInfo(it));
      }
      // LangGraph drops a task from `next` once it has pending writes (e.g. the
      // persisted resume values of a re-prompted hitl node), even though it is
      // still waiting on an interrupt. Report it as pending.
      if ((task.interrupts?.length ?? 0) > 0 && task.name && !next.includes(task.name)) {
        next.push(task.name);
      }
    }
    if (threadId) enrichInterruptsWithWebhookUrls(interrupts, threadId);
    if (
      interrupts.length === 0 &&
      snap.next.length > 0 &&
      (interruptBefore.length || interruptAfter.length)
    ) {
      interrupts.push({
        id: `breakpoint:${snap.next.join(",")}`,
        reason: `Paused before: ${snap.next.join(", ")}`,
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
      const snap = await compiledLg.getState({ configurable: { thread_id: continueOpts.threadId } });
      const hasInterrupt = (snap?.tasks ?? []).some(
        (t) => Array.isArray(t.interrupts) && t.interrupts.length > 0,
      );
      if (hasInterrupt) {
        // LangGraph rejects Command({ resume: null }) as empty input.
        payload = new Command({ resume: true });
      }
    }
    return executeInvoke(payload, continueOpts, "continue", overrides);
  };

  const resume = async (resumeOpts: ResumeOptions): Promise<RunResult> => {
    let payload: Record<string, unknown> | Command | null = new Command({
      resume: resumeOpts.resume,
    });
    if (checkpointer) {
      const snap = await compiledLg.getState({ configurable: { thread_id: resumeOpts.threadId } });
      const hasInterrupt = (snap?.tasks ?? []).some(
        (t) => Array.isArray(t.interrupts) && t.interrupts.length > 0,
      );
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
    run: (runOpts: RunOptions = {}) => executeInvoke(runOpts.input ?? {}, runOpts, "start"),
    resume,
    continueRun: (opts: ContinueOptions) => continueRun(opts),
    getState: async (threadId: string) => {
      if (!checkpointer) return null;
      let snap = await compiledLg.getState({ configurable: { thread_id: threadId } });
      await hydrateDurableRuntime(snap, threadId, graphSpec, { executeInvoke, rehydrateWebhooks: true });
      const expired = expiredWaitResume(snap);
      if (expired) {
        await executeInvoke(new Command({ resume: expired }), { threadId, resume: expired, onInterrupt: "fail" }, "resume");
        snap = await compiledLg.getState({ configurable: { thread_id: threadId } });
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
      const streamP = events.stream();
      executeInvoke(runOpts.input ?? {}, runOpts, "start").catch(() => {});
      yield* streamP;
    },
  };
}

async function assembleCompiledLangGraph(spec: GraphSpec, opts: CompileOptions): Promise<AssembledGraph> {
  // Auto-declare channels targeted by output/collect/stateMap.out so LangGraph
  // does not silently drop node updates when authors omit state.channels entries.
  spec = ensureDeclaredOutputChannels(spec);

  const cwd = opts.cwd ?? process.cwd();
  const graphDir =
    opts.graphPath != null
      ? path.dirname(path.resolve(cwd, opts.graphPath))
      : cwd;
  const graphWorkspace = resolveGraphWorkspace(spec, graphDir);
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const events = createEventBus({ runId, graph: spec.metadata.name });
  for (const sink of opts.sinks ?? []) events.subscribe(sink);

  for (const extra of opts.extraFactories ?? []) {
    if (!registry.has(extra.type)) registry.register(extra);
  }
  for (const provider of opts.providers ?? []) registerProvider(provider);

  const imported = await loadGraphImports(spec, { cwd: graphDir });
  const skillAliases: Record<string, string> = { ...(opts.runConfig?.skills ?? {}), ...imported.skillAliases };
  const agentAliases: Record<string, string> = { ...(opts.runConfig?.agents ?? {}), ...imported.agentAliases };
  const subgraphAliases: Record<string, string> = { ...(opts.runConfig?.subgraphs ?? {}), ...imported.subgraphAliases };

  const StateAnnotation = buildStateAnnotation(spec);
  const graph = new StateGraph(StateAnnotation);

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

  const toolWiring: ToolWiring = { mcp: opts.mcp };
  const compiledNodes = new Map<string, ReturnType<NodeFactory["build"]>>();

  const hooks: HookBus = createHookBus(events);
  for (const h of defaultGuardrailHooks(spec)) hooks.register(h);
  for (const h of hooksFromSpec(spec)) hooks.register(h);
  for (const h of opts.hooks ?? []) hooks.register(h);

  const { runtime: memoryRuntime, store } = resolveMemory(spec, opts);

  const baseCtx: Partial<RunContext> = {
    config: {
      ...(opts.runConfig ?? {}),
      defaults: { ...(spec.config?.defaults ?? {}), ...(opts.runConfig?.defaults ?? {}) },
      vars: { ...(spec.config?.vars ?? {}), ...(opts.runConfig?.vars ?? {}) },
      skills: skillAliases,
      agents: agentAliases,
      subgraphs: subgraphAliases,
    },
    secrets: createEnvSecretProvider(),
    events,
    workspace: graphWorkspace,
    budget,
    hooks,
    mcp: opts.mcp,
    store,
  };
  if (memoryRuntime) (baseCtx as Record<symbol, unknown>)[MEMORY_RUNTIME] = memoryRuntime;

  const defaultRetry = spec.runtime?.retry;
  const defaultTimeout = spec.runtime?.timeoutDefault;

  const mapJoinById = new Map<string, string>();

  for (const nodeSpec of spec.nodes) {
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
        },
        mapJoinById,
      );
      continue;
    }

    const compiled = factory.build(
      {
        graphName: spec.metadata.name,
        toolWiring,
        ...(spec.runtime?.worktrees?.root ? { worktreeRoot: spec.runtime.worktrees.root } : {}),
      } as Parameters<typeof factory.build>[0],
      nodeSpec as unknown as Record<string, unknown>,
      configResult.data,
    );
    compiledNodes.set(nodeSpec.id, compiled);

    const nodeRetry = nodeSpec.retry ?? defaultRetry;
    const nodeTimeout = nodeSpec.timeout ?? defaultTimeout;
    const scope = { nodeId: nodeSpec.id, nodeType: nodeSpec.type };
    const nsRecord = nodeSpec as unknown as Record<string, unknown>;

    type NodeRun = { res: NodeResult; ctx: NodeRunContext & { _onceUpdates: Record<string, unknown>; _issueUpdates: RunIssue[] } };
    const runOnce = (
      state: Record<string, unknown>,
      inputOverride?: Record<string, unknown>,
      lgConfig?: LangGraphRunnableConfig,
    ): Promise<NodeRun> =>
      runWithPolicy<NodeRun>(
        (attempt) => {
          const ctx = buildNodeCtx(nsRecord, state, baseCtx, events, graphWorkspace, attempt, inputOverride, lgConfig);
          return compiled.run(state, ctx).then((res) => ({ res, ctx }));
        },
        {
          retry: nodeRetry as RetryConfigInput,
          timeout: nodeTimeout,
          signal: baseCtx.signal,
          onRetry: (info) => events.emit("node.retry", { nodeId: nodeSpec.id, ...info }, scope),
          onTimeout: (info) => events.emit("node.timeout", { nodeId: nodeSpec.id, ...info }, scope),
        },
      );

    const finalizeUpdate = (run: NodeRun): Record<string, unknown> => {
      const update = resultToUpdate(run.res);
      const onceUpdates = run.ctx._onceUpdates;
      if (Object.keys(onceUpdates).length > 0) update[ONCE_CHANNEL] = onceUpdates;
      if (run.ctx._issueUpdates.length > 0) update[ISSUES_CHANNEL] = run.ctx._issueUpdates;
      return update;
    };

    // Routers (and any routing-capable node) declare Command.goto destinations via
    // `ends` so LangGraph accepts goto without requiring a duplicate branch edge.
    const routeEnds = collectRouteEnds(nodeSpec);
    const addNodeOpts = routeEnds.length > 0 ? { ends: routeEnds } : undefined;

    graph.addNode(nodeSpec.id, async (state: Record<string, unknown>, lgConfig?: LangGraphRunnableConfig) => {
      const runMeta = (baseCtx.meta ?? { runId, graph: spec.metadata.name, startedAt: "" }) as RunMeta;

      // Graceful pause: park before this node so continueRun can resume it.
      const pauseSignal = (baseCtx as RunContext & { pauseSignal?: AbortSignal }).pauseSignal;
      if (pauseSignal?.aborted) {
        lgInterrupt({ reason: "paused", __flowgraphPause: true });
      }

      // `when` guard
      if (nodeSpec.when) {
        const expr = nodeSpec.when.replace(/^\s*\{\{|\}\}\s*$/g, "").trim();
        const guardScope = { state, config: baseCtx.config ?? {}, run: baseCtx.meta ?? {} };
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
        if (c?.kind === "interrupt") lgInterrupt({ reason: c.reason, data: c.payload });
        inputOverride = r.payload.input as Record<string, unknown> | undefined;
      }

      events.emit("node.start", { nodeId: nodeSpec.id, type: nodeSpec.type }, scope);

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
            events.emit("node.end", { nodeId: nodeSpec.id, update, routed: c.to }, scope);
            return new Command({ goto: c.to, update }) as unknown as Record<string, unknown>;
          }
          update = (r.payload.update as Record<string, unknown> | undefined) ?? update;
        }

        // state:beforeUpdate — redact / transform the delta before commit
        if (hooks.has("state:beforeUpdate")) {
          const r = await hooks.run("state:beforeUpdate", { state, run: runMeta, payload: { nodeId: nodeSpec.id, nodeType: nodeSpec.type, update } });
          update = (r.payload.update as Record<string, unknown> | undefined) ?? update;
        }

        if (nodeGoto != null) {
          events.emit("node.end", { nodeId: nodeSpec.id, update, routed: nodeGoto }, scope);
          return new Command({ goto: nodeGoto, update }) as unknown as Record<string, unknown>;
        }

        events.emit("node.end", { nodeId: nodeSpec.id, update }, scope);
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
            const retried = await runOnce(state, inputOverride, lgConfig);
            const update = finalizeUpdate(retried);
            events.emit("node.end", { nodeId: nodeSpec.id, update }, scope);
            return update;
          }
        }
        events.emit("node.error", { nodeId: nodeSpec.id, error: String(err) }, scope);
        throw err;
      }
    }, addNodeOpts as Parameters<typeof graph.addNode>[2]);
  }

  // Node-as-tool: run a sibling node's logic with the agent-supplied args as
  // its input against the calling agent's state snapshot. Returns the node's
  // raw result (the outputs slug) so the LLM sees clean data, not the update envelope.
  toolWiring.invokeNode = async (id, args, ctx, state = {}) => {
    const target = compiledNodes.get(id);
    if (!target) throw new Error(`node-as-tool: no node "${id}" in this graph.`);
    const childCtx = {
      ...ctx,
      nodeId: id,
      _input: args,
      render(template: string, extra: Record<string, unknown> = {}) {
        const issues = (state[ISSUES_CHANNEL] as RunIssue[] | undefined) ?? [];
        return renderDeep(template, { state, input: args, config: ctx.config, run: ctx.meta, issues, ...extra });
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
  const routerIds = new Set(spec.nodes.filter((n) => n.type === "router").map((n) => n.id));
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
): void {
  clearWaitTimeoutTimer(waitTimeoutTimers, threadId);
  const deadline = earliestDeadlineMs(interrupts);
  if (deadline === undefined) return;
  const delay = Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => {
    waitTimeoutTimers.delete(threadId);
    onFire();
  }, delay);
  timer.unref?.();
  waitTimeoutTimers.set(threadId, timer);
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
  const mapConc = spec.nodes
    .filter((n) => n.type === "map")
    .map((n) => {
      const c = (n.with as { concurrency?: number } | undefined)?.concurrency;
      return typeof c === "number" ? c : undefined;
    })
    .filter((n): n is number => n != null);
  const concurrency = spec.runtime?.concurrency ?? (mapConc.length ? Math.min(...mapConc) : undefined);
  const recursionLimit = spec.runtime?.recursionLimit;
  return {
    configurable: {
      thread_id: threadId,
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    },
    ...(concurrency ? { maxConcurrency: concurrency } : {}),
    ...(recursionLimit ? { recursionLimit } : {}),
  };
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
  if (opts.checkpointer === "memory") return new MemorySaver();

  const backend = spec.runtime?.checkpoint?.backend ?? "memory";
  if (backend === "memory") return new MemorySaver();
  if (backend === "postgres" || backend === "sqlite") {
    throw new Error(
      `runtime.checkpoint.backend "${backend}" requires passing a checkpointer instance to compileGraph ` +
        `(the CLI wires sqlite/postgres from runtime.checkpoint.path / DATABASE_URL). ` +
        `Silent MemorySaver fallback is not allowed.`,
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

function memoryUnavailable(what: string, checkpoint: string | undefined): MemoryError {
  const tail =
    `Silent in-memory fallback is not allowed — use runtime.memory.backend: memory for an ephemeral store in tests.`;
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
    const ephemeral = () => createEphemeralMemoryRuntime(graph, { config: memCfg, exposeMemory, identity: host?.identity });
    if (memCfg?.backend === "memory") {
      runtime = ephemeral();
    } else if (host && exposeMemory) {
      // Only graphs that opt into durable memory (runtime.memory, or
      // runtime.store.backend sqlite|postgres) land in the host backend; a
      // plain graph keeps its process-local ctx.store as before.
      runtime = new MemoryRuntime({
        backend: host.backend,
        identity: host.identity ?? LOCAL_MEMORY_IDENTITY,
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
        throw memoryUnavailable(memCfg ? "runtime.memory" : `runtime.store.backend "${storeBackend}"`, ckBackend);
      }
    } else if (opts.legacyStoreBackend && !exposeMemory) {
      runtime = new MemoryRuntime({
        backend: opts.legacyStoreBackend,
        identity: host?.identity ?? LOCAL_MEMORY_IDENTITY,
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

function resultToUpdate(result: NodeResult): Record<string, unknown> {
  if ("update" in result) return result.update;
  if ("command" in result) return result.command.update ?? {};
  if ("interrupt" in result) throw new Error(`HITL interrupt: ${result.interrupt.reason}`);
  return {};
}

/** Collect Command.goto destinations declared on a router node's `with.routes`. */
function collectRouteEnds(nodeSpec: { type: string; with?: unknown }): string[] {
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
  const route = getWebhookRoute(threadId);
  if (!route?.url) return;
  for (const info of interrupts) {
    if (!isWebhookInterrupt(info)) continue;
    setWebhookUrlOnInterrupt(info, route.url);
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
    ) => Promise<RunResult>;
    signal?: AbortSignal;
    sinks?: EventSink[];
  },
): Promise<void> {
  const webhookInterrupts = interrupts.filter(isWebhookInterrupt);
  if (webhookInterrupts.length === 0) return;

  const serverCfg = (opts.graphSpec.runtime as { webhookServer?: WebhookServerConfig } | undefined)
    ?.webhookServer;
  const info = await ensureWebhookServer(serverCfg);

  for (const interrupt of webhookInterrupts) {
    const nodeId = webhookNodeIdFromInterrupt(interrupt) ?? "unknown";
    const url = buildWebhookUrl(info.host, info.port, opts.threadId, nodeId);
    setWebhookUrlOnInterrupt(interrupt, url);

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
      url,
      ...(serverCfg?.token ? { token: serverCfg.token } : {}),
      resume: async (body) => {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        const result = await opts.executeInvoke(
          new Command({ resume: body }),
          {
            threadId: opts.threadId,
            resume: body,
            onInterrupt: "fail",
            ...(opts.sinks ? { sinks: opts.sinks } : {}),
          },
          "resume",
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
  const reserved = new Set<string>([...RESERVED_STATE_CHANNELS, "__interrupt__"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (reserved.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Tear down non-keepAlive services (and optional worktrees) when a run reaches completed/error. */
async function maybeTerminateServices(spec: GraphSpec, threadId: string, state?: Record<string, unknown>): Promise<void> {
  const terminate = spec.runtime?.services?.terminateOnEnd ?? true;
  if (terminate) {
    try {
      await terminateThreadServices(threadId);
    } catch {
      /* best-effort cleanup — do not fail the run result */
    }
  }
  if (spec.runtime?.worktrees?.cleanupOnEnd) {
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
  const scope = { state, config: base.config ?? {}, run: base.meta ?? {} };
  const _input = inputOverride
    ?? (nodeSpec["input"]
      ? (renderDeep(nodeSpec["input"] as Record<string, string>, scope) as Record<string, unknown>)
      : {});

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
    meta: (base.meta ?? { runId: "", graph: "", startedAt: "" }) as RunContext["meta"],
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
        run: base.meta,
        issues,
        ...extra,
      });
    },
    emit(type, data) { events.emit(type, data, { nodeId, nodeType, ...(parentSpanId ? { parentSpanId } : {}) }); },
    interrupt<T = unknown>(payload: { reason: string; data?: unknown; kind?: import("./context.js").InterruptKind }): T {
      const data =
        payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
          ? { ...(payload.data as Record<string, unknown>), __nodeId: nodeId }
          : { ...(payload.data !== undefined ? { value: payload.data } : {}), __nodeId: nodeId };
      const threadId = (base.meta as RunMeta | undefined)?.threadId ?? (base.meta as RunMeta | undefined)?.runId;
      if (threadId) {
        const key = replayCacheKey(threadId, nodeId);
        const dump = snapshotReplay(key);
        if (Object.keys(dump).length > 0) {
          (data as Record<string, unknown>)["__agentReplay"] = { key, entries: dump };
        }
      }
      const tagged = { ...payload, data };
      events.emit("interrupt.raised", { reason: tagged.reason, data: tagged.data }, { nodeId, nodeType });
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
            ...(base.meta?.threadId ? { threadId: base.meta.threadId } : {}),
            ...(base.meta?.runId ? { runId: base.meta.runId } : {}),
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
  if (base.signal !== undefined) ctx.signal = base.signal;
  const memoryRuntime = (base as Record<symbol, unknown>)[MEMORY_RUNTIME] as MemoryRuntime | undefined;
  if (memoryRuntime?.exposeMemory) {
    const conf = (lgConfig?.configurable ?? {}) as Record<string, unknown>;
    const threadId = typeof conf["thread_id"] === "string" ? conf["thread_id"] : base.meta?.threadId;
    const memory = memoryRuntime.memoryFor(threadId, {
      checkpointNs: typeof conf["checkpoint_ns"] === "string" ? conf["checkpoint_ns"] : undefined,
      taskId: typeof conf["__pregel_task_id"] === "string" ? conf["__pregel_task_id"] : undefined,
      nodeId,
      runId: base.meta?.runId,
    });
    if (memory) ctx.memory = memory;
  }
  return ctx;
}

function resolveGraphWorkspace(spec: GraphSpec, graphDir: string): string {
  const raw = spec.runtime?.workspace;
  if (typeof raw !== "string" || !raw.trim()) return graphDir;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(graphDir, raw);
}

function expiredWaitResume(snap: {
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ id?: string; value?: unknown }> }>;
} | null | undefined): { timedOut: true } | undefined {
  if (!snap) return undefined;
  const now = Date.now();
  for (const task of snap.tasks ?? []) {
    for (const it of task.interrupts ?? []) {
      const info = toInterruptInfo(it);
      if (info.deadlineAt && Date.parse(info.deadlineAt) <= now) {
        return { timedOut: true };
      }
    }
  }
  return undefined;
}

async function hydrateDurableRuntime(
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
    ) => Promise<RunResult>;
    signal?: AbortSignal;
    sinks?: EventSink[];
    rehydrateWebhooks?: boolean;
  },
): Promise<void> {
  if (!snap) return;
  for (const task of snap.tasks ?? []) {
    for (const it of task.interrupts ?? []) {
      hydrateReplayFromInterruptPayload(it.value);
    }
  }
  const replayState = snap.values?.[REPLAY_CHANNEL];
  if (replayState && typeof replayState === "object" && !Array.isArray(replayState)) {
    for (const [key, entries] of Object.entries(replayState as Record<string, unknown>)) {
      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        hydrateReplay(key, entries as Record<string, unknown>);
      }
    }
  }

  const interrupts: InterruptInfo[] = [];
  for (const task of snap.tasks ?? []) {
    for (const it of task.interrupts ?? []) interrupts.push(toInterruptInfo(it));
  }
  if (opts.rehydrateWebhooks !== false && interrupts.some(isWebhookInterrupt) && !getWebhookRoute(threadId)) {
    await attachWebhookUrls(interrupts, {
      threadId,
      graphSpec,
      executeInvoke: opts.executeInvoke,
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
  nodeSpec: { id: string; type: string; with?: unknown; retry?: unknown; timeout?: unknown },
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
  const buildCtx = {
    graphName: spec.metadata.name,
    toolWiring: ctx.toolWiring,
    ...(spec.runtime?.worktrees?.root ? { worktreeRoot: spec.runtime.worktrees.root } : {}),
  };
  const nodeRetry = (nodeSpec.retry ?? ctx.defaultRetry) as RetryConfigInput;
  const nodeTimeout = (nodeSpec.timeout ?? ctx.defaultTimeout) as string | undefined;

  graph.addNode(
    mapId,
    async (state: Record<string, unknown>) => {
      const scope = { state, config: ctx.baseCtx.config ?? {}, run: ctx.baseCtx.meta ?? {} };
      const collection = renderDeep(config.over, scope);
      if (!Array.isArray(collection)) {
        throw new Error(`map node "${mapId}": "over" did not evaluate to an array.`);
      }
      ctx.events.emit("node.start", { nodeId: mapId, type: "map" }, { nodeId: mapId, nodeType: "map" });
      ctx.events.emit("node.output", { map: { over: config.over, count: collection.length, concurrency: config.concurrency } }, { nodeId: mapId, nodeType: "map" });
      if (collection.length === 0) {
        const update = collectMapResults(config, [], mapId, scope);
        ctx.events.emit("node.end", { nodeId: mapId, update }, { nodeId: mapId, nodeType: "map" });
        return new Command({ goto: joinId, update }) as unknown as Record<string, unknown>;
      }
      return new Command({
        goto: collection.map(
          (item, index) =>
            new Send(workerId, {
              ...state,
              [MAP_TASK_CHANNEL]: { mapId, index, item, as: config.as, count: collection.length } satisfies MapTask,
            }),
        ),
      }) as unknown as Record<string, unknown>;
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
    ctx.events.emit("node.start", { nodeId: itemId, type: innerType, mapId, index: task.index }, itemScope);

    try {
      const run = await runWithPolicy(
        (attempt) => {
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
          return runMapItem(buildCtx, mapId, config, state, nodeCtx, task).then((value) => ({
            value,
            onceUpdates: nodeCtx._onceUpdates,
            issueUpdates: nodeCtx._issueUpdates,
          }));
        },
        {
          retry: nodeRetry,
          timeout: nodeTimeout,
          signal: ctx.baseCtx.signal,
          onRetry: (info) => ctx.events.emit("node.retry", { nodeId: itemId, ...info }, itemScope),
          onTimeout: (info) => ctx.events.emit("node.timeout", { nodeId: itemId, ...info }, itemScope),
        },
      );
      ctx.events.emit("node.end", { nodeId: itemId, mapId, index: task.index }, itemScope);
      const update: Record<string, unknown> = {
        [MAP_COLLECT_CHANNEL]: { [mapId]: [{ i: task.index, v: run.value }] },
      };
      if (Object.keys(run.onceUpdates).length > 0) update[ONCE_CHANNEL] = run.onceUpdates;
      if (run.issueUpdates.length > 0) update[ISSUES_CHANNEL] = run.issueUpdates;
      return update;
    } catch (err) {
      if (isInterruptLike(err)) throw err;
      ctx.events.emit("node.error", { nodeId: itemId, error: String(err) }, itemScope);
      throw err;
    }
  });

  graph.addNode(joinId, async (state: Record<string, unknown>) => {
    const bagRaw = (state[MAP_COLLECT_CHANNEL] as Record<string, unknown> | undefined)?.[mapId];
    const bag = Array.isArray(bagRaw) ? (bagRaw as Array<{ i: number; v: unknown }>) : [];
    const scope = { state, config: ctx.baseCtx.config ?? {}, run: ctx.baseCtx.meta ?? {} };
    const update = collectMapResults(config, bag, mapId, scope);
    ctx.events.emit("node.end", { nodeId: mapId, update, joined: true }, { nodeId: mapId, nodeType: "map" });
    return update;
  });

  graph.addEdge(workerId as typeof START, joinId as typeof END);
}
