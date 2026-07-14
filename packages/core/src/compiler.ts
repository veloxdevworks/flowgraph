/**
 * Stage 2: build a LangGraph StateGraph from a validated GraphSpec,
 * plus run/resume/inspect with durability, HITL, and retry/timeout.
 */

import { START, END, StateGraph, MemorySaver, InMemoryStore, Command, type BaseCheckpointSaver, type BaseStore, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { interrupt as lgInterrupt } from "@langchain/langgraph";
import * as path from "node:path";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { evalGuard, renderDeep } from "@veloxdevworks/flowgraph-expr";
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
import { buildStateAnnotation, ONCE_CHANNEL } from "./runtime/state-annotation.js";
import { warnFanInLastWrite } from "./runtime/fan-in-warning.js";
import { loadGraphImports } from "./runtime/load-imports.js";
import { runWithPolicy, type RetryConfig as RetryConfigInput } from "./runtime/retry.js";
import { registerProvider, type ProviderAdapter } from "./providers/index.js";
import type { ToolWiring } from "./providers/tools.js";
import type { BudgetState } from "./context.js";
import type { McpHub } from "./mcp/types.js";
import { createHookBus, type HookBus } from "./hooks/bus.js";
import type { Hook } from "./hooks/types.js";
import { hooksFromSpec, defaultGuardrailHooks } from "./hooks/builtin.js";
import "./nodes/index.js";

export type InterruptPolicy = "prompt" | "fail" | "approve" | "webhook";

export interface CompileOptions {
  cwd?: string;
  /** Graph file path — `imports` specifiers resolve relative to this file's directory. */
  graphPath?: string;
  sinks?: EventSink[];
  runConfig?: RunConfig;
  checkpointer?: "memory" | "none" | BaseCheckpointSaver;
  store?: "memory" | "none" | BaseStore;
  extraFactories?: NodeFactory[];
  providers?: ProviderAdapter[];
  interruptBefore?: string[];
  interruptAfter?: string[];
  /** Programmatic hooks registered in addition to YAML-bound + default hooks. */
  hooks?: Hook[];
  /** MCP hub for mcp nodes and intelligent MCP tools (built from mcpServers by CLI). */
  mcp?: McpHub;
}

export interface InterruptInfo {
  id: string;
  reason?: string;
  payload?: unknown;
  /** How the interrupt should be answered (approval, free-text question, choice list). */
  kind?: import("./context.js").InterruptKind;
  choices?: string[];
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
  status: "completed" | "interrupted" | "paused" | "error";
  state: Record<string, unknown>;
  runId: string;
  threadId?: string | undefined;
  interrupts?: InterruptInfo[] | undefined;
  error?: Error | undefined;
  durationMs: number;
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
  stream(opts?: RunOptions): AsyncIterable<FlowgraphEvent>;
}

type ExecuteMode = "start" | "resume" | "continue";

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

  const executeInvoke = async (
    payload: Record<string, unknown> | Command | null,
    runOpts: RunOptions | ResumeOptions | ContinueOptions,
    mode: ExecuteMode,
  ): Promise<RunResult> => {
    const startMs = Date.now();
    const threadId = runOpts.threadId ?? `thread-${runId}`;
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
    const cfg = buildInvokeConfig(threadId, graphSpec);

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

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = ((await compiledLg.invoke(
          current as Parameters<typeof compiledLg.invoke>[0],
          { ...cfg, signal: runOpts.signal } as Parameters<typeof compiledLg.invoke>[1],
        )) ?? {}) as Record<string, unknown>;

        const interrupts = extractInterrupts(result);

        if (isPauseInterrupt(interrupts)) {
          const clean = stripReserved(result);
          events.emit("run.paused", { state: clean, durationMs: Date.now() - startMs });
          return {
            status: "paused",
            state: clean,
            runId,
            threadId,
            durationMs: Date.now() - startMs,
          };
        }

        if (interrupts.length === 0) {
          if (checkpointer && (interruptBefore.length || interruptAfter.length)) {
            const snap = await compiledLg.getState(cfg);
            if (snap && Array.isArray(snap.next) && snap.next.length > 0) {
              const clean = stripReserved(result);
              const bp: InterruptInfo[] = [{ id: `breakpoint:${snap.next.join(",")}`, reason: `Paused before: ${snap.next.join(", ")}` }];
              events.emit("interrupt.raised", { interrupts: bp });
              if (policy === "fail" || policy === "webhook" || !runOpts.resolveInterrupt) {
                return { status: "interrupted", state: clean, runId, threadId, interrupts: bp, durationMs: Date.now() - startMs };
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
          return { status: "completed", state: clean, runId, threadId, durationMs: Date.now() - startMs };
        }

        events.emit("interrupt.raised", { interrupts });

        if (policy === "fail" || policy === "webhook") {
          const clean = stripReserved(result);
          return {
            status: "interrupted",
            state: clean,
            runId,
            threadId,
            interrupts,
            durationMs: Date.now() - startMs,
          };
        }

        let resumeValue: unknown;
        if (runOpts.resolveInterrupt) {
          resumeValue = await runOpts.resolveInterrupt(interrupts);
        } else if (policy === "approve") {
          resumeValue = true;
        } else {
          const clean = stripReserved(result);
          return {
            status: "interrupted",
            state: clean,
            runId,
            threadId,
            interrupts,
            durationMs: Date.now() - startMs,
          };
        }

        events.emit("interrupt.resumed", { resume: resumeValue });
        current = new Command({ resume: resumeValue });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (hooks.has("run:error")) {
        try { await hooks.run("run:error", { state: {}, run: runMeta, payload: { error } }); } catch { /* ignore */ }
      }
      events.emit("run.error", { error: error.message, durationMs: Date.now() - startMs });
      return { status: "error", state: {}, runId, threadId, error, durationMs: Date.now() - startMs };
    } finally {
      delete (baseCtx as RunContext & { pauseSignal?: AbortSignal }).pauseSignal;
      for (const u of unsubs) u();
    }
  };

  const toSnapshot = (
    snap: { values: Record<string, unknown>; next: readonly string[]; config?: { configurable?: { checkpoint_id?: string } }; createdAt?: string; tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ id: string; value?: unknown }> }> },
  ): StateSnapshot => {
    const interrupts: InterruptInfo[] = [];
    for (const task of snap.tasks ?? []) {
      for (const it of task.interrupts ?? []) {
        interrupts.push(toInterruptInfo(it));
      }
    }
    return {
      values: stripReserved(snap.values),
      next: [...snap.next],
      checkpointId: snap.config?.configurable?.checkpoint_id,
      createdAt: snap.createdAt,
      interrupts,
    };
  };

  const continueRun = async (continueOpts: ContinueOptions): Promise<RunResult> => {
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
    return executeInvoke(payload, continueOpts, "continue");
  };

  return {
    spec: graphSpec,
    runId,
    events,
    run: (runOpts: RunOptions = {}) => executeInvoke(runOpts.input ?? {}, runOpts, "start"),
    resume: (resumeOpts: ResumeOptions) =>
      executeInvoke(new Command({ resume: resumeOpts.resume }), resumeOpts, "resume"),
    continueRun,
    getState: async (threadId: string) => {
      if (!checkpointer) return null;
      const snap = await compiledLg.getState({ configurable: { thread_id: threadId } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return toSnapshot(snap as any);
    },
    getStateHistory: async (threadId: string) => {
      if (!checkpointer) return [];
      const snapshots: StateSnapshot[] = [];
      for await (const snap of compiledLg.getStateHistory({ configurable: { thread_id: threadId } })) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snapshots.push(toSnapshot(snap as any));
      }
      return snapshots;
    },
    stream: async function* (runOpts: RunOptions = {}) {
      const streamP = events.stream();
      executeInvoke(runOpts.input ?? {}, runOpts, "start").catch(() => {});
      yield* streamP;
    },
  };
}

async function assembleCompiledLangGraph(spec: GraphSpec, opts: CompileOptions): Promise<AssembledGraph> {
  const cwd = opts.cwd ?? process.cwd();
  const graphDir =
    opts.graphPath != null
      ? path.dirname(path.resolve(cwd, opts.graphPath))
      : cwd;
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const events = createEventBus({ runId, graph: spec.metadata.name });
  for (const sink of opts.sinks ?? []) events.subscribe(sink);

  for (const extra of opts.extraFactories ?? []) {
    if (!registry.has(extra.type)) registry.register(extra);
  }
  for (const provider of opts.providers ?? []) registerProvider(provider);

  const imported = await loadGraphImports(spec, { cwd: graphDir });
  const skillAliases: Record<string, string> = { ...(opts.runConfig?.skills ?? {}), ...imported.skillAliases };
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

  const store = resolveStore(spec, opts);

  const baseCtx: Partial<RunContext> = {
    config: {
      ...(opts.runConfig ?? {}),
      vars: { ...(spec.config?.vars ?? {}), ...(opts.runConfig?.vars ?? {}) },
      skills: skillAliases,
      subgraphs: subgraphAliases,
    },
    secrets: createEnvSecretProvider(),
    events,
    workspace: graphDir,
    budget,
    hooks,
    mcp: opts.mcp,
    store,
  };

  const defaultRetry = spec.runtime?.retry;
  const defaultTimeout = spec.runtime?.timeoutDefault;

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

    const compiled = factory.build(
      { graphName: spec.metadata.name, toolWiring } as Parameters<typeof factory.build>[0],
      nodeSpec as unknown as Record<string, unknown>,
      configResult.data,
    );
    compiledNodes.set(nodeSpec.id, compiled);

    const nodeRetry = nodeSpec.retry ?? defaultRetry;
    const nodeTimeout = nodeSpec.timeout ?? defaultTimeout;
    const scope = { nodeId: nodeSpec.id, nodeType: nodeSpec.type };
    const nsRecord = nodeSpec as unknown as Record<string, unknown>;

    type NodeRun = { res: NodeResult; ctx: NodeRunContext & { _onceUpdates: Record<string, unknown> } };
    const runOnce = (
      state: Record<string, unknown>,
      inputOverride?: Record<string, unknown>,
      lgConfig?: LangGraphRunnableConfig,
    ): Promise<NodeRun> =>
      runWithPolicy<NodeRun>(
        (attempt) => {
          const ctx = buildNodeCtx(nsRecord, state, baseCtx, events, graphDir, attempt, inputOverride, lgConfig);
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
      return update;
    };

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
            return {};
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
    });
  }

  // Node-as-tool: run a sibling node's logic with the agent-supplied args as
  // its input. Returns the node's state update (the tool result for the agent).
  toolWiring.invokeNode = async (id, args, ctx) => {
    const target = compiledNodes.get(id);
    if (!target) throw new Error(`node-as-tool: no node "${id}" in this graph.`);
    const childCtx = {
      ...ctx,
      nodeId: id,
      _input: args,
      render(template: string, extra: Record<string, unknown> = {}) {
        return renderDeep(template, { state: {}, input: args, config: ctx.config, run: ctx.meta, ...extra });
      },
    } as typeof ctx & { _input: Record<string, unknown> };
    const res = await target.run({}, childCtx);
    return resultToUpdate(res);
  };

  // Edges
  for (const edge of spec.edges) {
    const from = edge.from === "START" ? START : edge.from;
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

function buildInvokeConfig(threadId: string, spec: GraphSpec): Record<string, unknown> {
  const concurrency = spec.runtime?.concurrency;
  const recursionLimit = spec.runtime?.recursionLimit;
  return {
    configurable: { thread_id: threadId },
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

  const backend = spec.runtime?.checkpoint?.backend ?? (opts.checkpointer as string) ?? "memory";
  if (backend === "memory") return new MemorySaver();
  // sqlite/postgres are provided by external packages and passed as instances.
  return new MemorySaver();
}

function resolveStore(spec: GraphSpec, opts: CompileOptions): BaseStore | undefined {
  if (opts.store && typeof opts.store === "object") {
    return opts.store;
  }
  const enabled = spec.runtime?.store?.enabled !== false;
  if (!enabled) return undefined;
  if (opts.store === "none") return undefined;

  const backend = spec.runtime?.store?.backend ?? (opts.store as string) ?? "memory";
  if (backend === "none") return undefined;
  if (backend === "memory") return new InMemoryStore();
  // Durable backends are provided by external packages and passed as instances.
  return new InMemoryStore();
}

function resultToUpdate(result: NodeResult): Record<string, unknown> {
  if ("update" in result) return result.update;
  if ("command" in result) return result.command.update ?? {};
  if ("interrupt" in result) throw new Error(`HITL interrupt: ${result.interrupt.reason}`);
  return {};
}

function isInterruptLike(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  return name === "GraphInterrupt" || name === "NodeInterrupt" || "lg_interrupt" in err;
}

function extractInterrupts(result: Record<string, unknown>): InterruptInfo[] {
  const raw = result["__interrupt__"];
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => toInterruptInfo(it as { id: string; value?: unknown }));
}

function toInterruptInfo(it: { id: string; value?: unknown }): InterruptInfo {
  const value = it.value as
    | { reason?: string; kind?: InterruptInfo["kind"]; data?: { choices?: string[] } }
    | undefined;
  const info: InterruptInfo = { id: it.id, payload: it.value, kind: "approval" };
  if (value && typeof value === "object") {
    if (typeof value.reason === "string") info.reason = value.reason;
    if (value.kind) info.kind = value.kind;
    const choices = value.data?.choices;
    if (Array.isArray(choices) && choices.length > 0) info.choices = choices;
  }
  return info;
}

function stripReserved(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k === ONCE_CHANNEL || k === "__interrupt__") continue;
    out[k] = v;
  }
  return out;
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

  const ctx: NodeRunContext & {
    _input: Record<string, unknown>;
    _onceUpdates: Record<string, unknown>;
    _lgConfig?: LangGraphRunnableConfig;
  } = {
    ...(base as RunContext),
    meta: (base.meta ?? { runId: "", graph: "", startedAt: "" }) as RunContext["meta"],
    secrets: base.secrets!,
    events,
    logger: (base as RunContext).logger ?? { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    workspace,
    nodeId,
    nodeType,
    attempt,
    _input,
    _onceUpdates,
    render(template: string, extra: Record<string, unknown> = {}) {
      return renderDeep(template, { state, input: _input, config: base.config, run: base.meta, ...extra });
    },
    emit(type, data) { events.emit(type, data, { nodeId, nodeType }); },
    interrupt<T = unknown>(payload: { reason: string; data?: unknown }): T {
      events.emit("interrupt.raised", { reason: payload.reason, data: payload.data }, { nodeId, nodeType });
      return lgInterrupt(payload) as T;
    },
    async once<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
      const scopedKey = `${nodeId}:${key}`;
      if (scopedKey in onceState) return onceState[scopedKey] as T;
      const value = await fn();
      _onceUpdates[scopedKey] = value;
      return value;
    },
  };
  if (lgConfig !== undefined) ctx._lgConfig = lgConfig;
  if (base.signal !== undefined) ctx.signal = base.signal;
  return ctx;
}
