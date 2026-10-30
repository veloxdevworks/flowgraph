import * as path from "node:path";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  compileGraph,
  createInMemoryMemoryBackend,
  resolveAndValidateInput,
  isInputValidationError,
  readRunIssues,
  type CompiledGraph,
  type FlowgraphEvent,
  type MemoryBackend,
  type RunIssue,
  type RunResult,
} from "@flowgraph/core";
import { createPostgresCheckpointer } from "@flowgraph/checkpoint-postgres";
import type { GraphSpec } from "@flowgraph/spec";
import { rejectClientSecrets, applyServerCredentials } from "./credentials.js";
import { parseGraphYaml, persistGraph, loadPersistedGraph, updateGraphMeta, listPersistedGraphs, appendEventJournal, loadEventJournal } from "./graph-source.js";
import { buildServerProviders } from "./providers.js";
import { SessionRegistry } from "./session-registry.js";
import { createMetrics, errorFields, log } from "./metrics.js";
import type {
  ControlResult,
  GetStateResult,
  RunDetail,
  RunListItem,
  ServerConfig,
  ServerEvent,
  StartRunRequest,
  StartRunResult,
  ResumeRunRequest,
} from "./types.js";

import { TooManyRunsError } from "./errors.js";

export class RunService {
  readonly registry: SessionRegistry;
  readonly metrics = createMetrics();
  private checkpointer: BaseCheckpointSaver | null = null;
  private checkpointerPromise: Promise<BaseCheckpointSaver> | null = null;
  /**
   * One in-process memory backend for the whole service. compile() runs on every
   * start/resume/getState, so a per-compile store would drop ctx.store data between a
   * run and its own resume. Each compile gets a graph-scoped ctx.store view on it, so
   * graphs never see each other's keys; the backend caps total items.
   */
  private readonly legacyStoreBackend: MemoryBackend = createInMemoryMemoryBackend({ maxItems: 50_000 });

  constructor(readonly config: ServerConfig) {
    this.registry = new SessionRegistry(config.eventBufferSize, {
      onPersist: (threadId, event) => {
        appendEventJournal(config.graphStoreDir, threadId, event);
      },
      loadJournal: (threadId) => loadEventJournal(config.graphStoreDir, threadId),
    });
    applyServerCredentials({
      ...(config.awsRegion ? { awsRegion: config.awsRegion } : {}),
    });
  }

  async init(): Promise<void> {
    await this.getCheckpointer();
    log("info", "run-service ready", {
      database: this.config.databaseUrl ? "postgres" : "memory",
      graphStoreDir: this.config.graphStoreDir,
    });
  }

  private async getCheckpointer(): Promise<BaseCheckpointSaver> {
    if (this.checkpointer) return this.checkpointer;
    if (!this.checkpointerPromise) {
      this.checkpointerPromise = (async () => {
        if (this.config.databaseUrl) {
          const cp = await createPostgresCheckpointer(this.config.databaseUrl);
          this.checkpointer = cp;
          return cp;
        }
        // One MemorySaver shared by every compile. Letting compileGraph create its own
        // per call gave each start/resume/getState an empty saver, so HITL resume
        // "completed" without running the remaining nodes.
        const cp = new MemorySaver();
        this.checkpointer = cp;
        return cp;
      })();
    }
    return this.checkpointerPromise;
  }

  private async resolveSpec(
    threadId: string,
    yaml?: string,
  ): Promise<{ spec: GraphSpec; yaml: string; cwd: string; importsStripped: boolean }> {
    if (yaml) {
      const parsed = parseGraphYaml(yaml);
      if (!parsed.spec) {
        const msg = parsed.diagnostics.map((d) => d.message).join("; ");
        throw new Error(`Invalid graph YAML: ${msg}`);
      }
      if (parsed.importsStripped) {
        log("warn", "stripped client imports from uploaded graph", { threadId });
      }
      await persistGraph(this.config.graphStoreDir, threadId, parsed.yaml, parsed.spec);
      return {
        spec: parsed.spec,
        yaml: parsed.yaml,
        cwd: this.config.graphStoreDir,
        importsStripped: parsed.importsStripped,
      };
    }

    const persisted = await loadPersistedGraph(this.config.graphStoreDir, threadId);
    if (!persisted) {
      throw new Error(
        `No persisted graph for thread "${threadId}". Provide yaml on start/resume.`,
      );
    }
    return {
      spec: persisted.spec,
      yaml: persisted.yaml,
      cwd: this.config.graphStoreDir,
      importsStripped: false,
    };
  }

  private async compile(
    spec: GraphSpec,
    cwd: string,
    threadId: string,
    onEvent: (ev: FlowgraphEvent) => void,
    dryRun = false,
  ): Promise<CompiledGraph> {
    const checkpointer = await this.getCheckpointer();
    const providers = await buildServerProviders(spec, cwd, { dryRun });
    const graphPath = path.join(cwd, `${threadId.replace(/[^a-zA-Z0-9._-]/g, "_")}.graph.yaml`);
    return compileGraph(spec, {
      cwd,
      graphPath,
      checkpointer,
      legacyStoreBackend: this.legacyStoreBackend,
      providers,
      sinks: [
        (event) => {
          onEvent(event);
        },
      ],
    });
  }

  async startRun(req: StartRunRequest): Promise<StartRunResult> {
    rejectClientSecrets(req.env);
    if (!req.threadId?.trim()) throw new Error("threadId is required");
    if (!req.yaml?.trim()) throw new Error("yaml is required");

    const max = this.config.maxConcurrentRuns ?? 16;
    if (max > 0 && this.registry.activeCount() >= max) {
      throw new TooManyRunsError(max);
    }

    const { spec, yaml, cwd, importsStripped } = await this.resolveSpec(req.threadId, req.yaml);
    const graphName = spec.metadata?.name ?? "graph";

    // Pre-create session so events during compile/run are buffered.
    const placeholder = this.registry.create({
      threadId: req.threadId,
      runId: "pending",
      graphName,
      ...(req.label ? { label: req.label } : {}),
      yaml,
      ...(req.dryRun ? { dryRun: true } : {}),
    });

    await persistGraph(this.config.graphStoreDir, req.threadId, yaml, spec, {
      ...(req.label ? { label: req.label } : {}),
      status: "running",
    });

    const compiled = await this.compile(spec, cwd, req.threadId, (ev) => {
      this.registry.pushEvent(req.threadId, ev);
    }, Boolean(req.dryRun));

    let resolvedInput: Record<string, unknown>;
    try {
      resolvedInput = resolveAndValidateInput(spec.inputs, {
        ...(spec.input ?? {}),
        ...(req.input ?? {}),
      });
    } catch (err) {
      this.registry.remove(req.threadId);
      if (isInputValidationError(err)) {
        throw new Error(err.message);
      }
      throw err;
    }

    placeholder.runId = compiled.runId;
    this.registry.setStatus(req.threadId, "running");
    this.metrics.recordStart();

    log("info", "run.start", {
      threadId: req.threadId,
      runId: compiled.runId,
      graph: graphName,
    });

    void (async () => {
      try {
        const result = await compiled.run({
          input: resolvedInput,
          threadId: req.threadId,
          onInterrupt: "fail",
          signal: placeholder.abort.signal,
          pauseSignal: placeholder.pause.signal,
        });
        this.applyResult(req.threadId, result);
      } catch (err) {
        log("error", "run.error", { threadId: req.threadId, ...errorFields(err) });
        this.registry.setStatus(req.threadId, "error");
        this.metrics.recordResult("error");
        void updateGraphMeta(this.config.graphStoreDir, req.threadId, { status: "error" });
        const message = err instanceof Error ? err.message : String(err);
        this.registry.pushEvent(req.threadId, {
          id: `err-${Date.now()}`,
          type: "run.error",
          ts: new Date().toISOString(),
          runId: compiled.runId,
          threadId: req.threadId,
          graph: graphName,
          scope: {},
          data: { message },
          seq: -1,
        });
      }
    })();

    return {
      threadId: req.threadId,
      runId: compiled.runId,
      status: "started",
      ...(importsStripped ? { importsStripped: true } : {}),
    };
  }

  private applyResult(threadId: string, result: RunResult): void {
    const status =
      result.status === "interrupted"
        ? "interrupted"
        : result.status === "paused"
          ? "paused"
          : result.status === "error"
            ? "error"
            : result.status === "aborted"
              ? "cancelled"
              : "completed";
    this.registry.setStatus(threadId, status);
    this.metrics.recordResult(result.status);
    log("info", "run.end", { threadId, status: result.status, runId: result.runId });
    void updateGraphMeta(this.config.graphStoreDir, threadId, { status });
  }

  async resumeRun(req: ResumeRunRequest): Promise<ControlResult> {
    if (!req.threadId?.trim()) throw new Error("threadId is required");

    const existing = this.registry.get(req.threadId);
    const yaml = req.yaml ?? existing?.yaml;
    const { spec, yaml: resolvedYaml, cwd } = await this.resolveSpec(req.threadId, yaml);
    const graphName = spec.metadata?.name ?? "graph";

    const abort = new AbortController();
    const pause = new AbortController();
    let session = this.registry.get(req.threadId);
    if (!session) {
      session = this.registry.create({
        threadId: req.threadId,
        runId: "pending",
        graphName,
        yaml: resolvedYaml,
      });
    } else {
      session.abort = abort;
      session.pause = pause;
      session.yaml = resolvedYaml;
    }

    const dryRun = Boolean(existing?.dryRun);
    const compiled = await this.compile(
      spec,
      cwd,
      req.threadId,
      (ev) => {
        this.registry.pushEvent(req.threadId, ev);
      },
      dryRun,
    );
    session.runId = compiled.runId;
    session.dryRun = dryRun;
    this.registry.setStatus(req.threadId, "running");
    void updateGraphMeta(this.config.graphStoreDir, req.threadId, { status: "running" });

    // Fire-and-forget like start/continue — resumed execution can be long-running.
    void (async () => {
      try {
        const result = await compiled.resume({
          threadId: req.threadId,
          resume: req.resume,
          onInterrupt: "fail",
          signal: abort.signal,
          pauseSignal: pause.signal,
        });
        this.applyResult(req.threadId, result);
      } catch (err) {
        log("error", "resume.error", { threadId: req.threadId, ...errorFields(err) });
        this.registry.setStatus(req.threadId, "error");
        this.metrics.recordResult("error");
        void updateGraphMeta(this.config.graphStoreDir, req.threadId, { status: "error" });
        const message = err instanceof Error ? err.message : String(err);
        this.registry.pushEvent(req.threadId, {
          id: `err-${Date.now()}`,
          type: "run.error",
          ts: new Date().toISOString(),
          runId: compiled.runId,
          threadId: req.threadId,
          graph: graphName,
          scope: {},
          data: { message },
          seq: -1,
        });
      }
    })();

    return {
      threadId: req.threadId,
      runId: compiled.runId,
      status: "started",
    };
  }

  async cancelRun(threadId: string): Promise<ControlResult> {
    const session = this.registry.get(threadId);
    if (!session) throw new Error(`No active session for thread "${threadId}"`);
    session.abort.abort();
    this.registry.setStatus(threadId, "cancelled");
    this.metrics.recordResult("cancelled");
    void updateGraphMeta(this.config.graphStoreDir, threadId, { status: "cancelled" });
    return { threadId, runId: session.runId, status: "cancelled" };
  }

  async pauseRun(threadId: string): Promise<ControlResult> {
    const session = this.registry.get(threadId);
    if (!session) throw new Error(`No active session for thread "${threadId}"`);
    session.pause.abort();
    void updateGraphMeta(this.config.graphStoreDir, threadId, { status: "paused" });
    return { threadId, runId: session.runId, status: "started" };
  }

  async continueRun(threadId: string, yaml?: string): Promise<ControlResult> {
    const existing = this.registry.get(threadId);
    const { spec, yaml: resolvedYaml, cwd } = await this.resolveSpec(
      threadId,
      yaml ?? existing?.yaml,
    );

    const abort = new AbortController();
    const pause = new AbortController();
    let session = this.registry.get(threadId);
    if (!session) {
      session = this.registry.create({
        threadId,
        runId: "pending",
        graphName: spec.metadata?.name ?? "graph",
        yaml: resolvedYaml,
      });
    } else {
      session.abort = abort;
      session.pause = pause;
    }

    const dryRun = Boolean(existing?.dryRun);
    const compiled = await this.compile(
      spec,
      cwd,
      threadId,
      (ev) => {
        this.registry.pushEvent(threadId, ev);
      },
      dryRun,
    );
    session.runId = compiled.runId;
    session.dryRun = dryRun;
    this.registry.setStatus(threadId, "running");
    void updateGraphMeta(this.config.graphStoreDir, threadId, { status: "running" });

    // Fire-and-forget like start (continue can be long-running)
    void (async () => {
      try {
        const result = await compiled.continueRun({
          threadId,
          onInterrupt: "fail",
          signal: abort.signal,
          pauseSignal: pause.signal,
        });
        this.applyResult(threadId, result);
      } catch (err) {
        log("error", "continue.error", { threadId, ...errorFields(err) });
        this.registry.setStatus(threadId, "error");
        this.metrics.recordResult("error");
        void updateGraphMeta(this.config.graphStoreDir, threadId, { status: "error" });
      }
    })();

    return { threadId, runId: compiled.runId, status: "started" };
  }

  async getState(threadId: string, yaml?: string): Promise<GetStateResult> {
    const existing = this.registry.get(threadId);
    const { spec, cwd } = await this.resolveSpec(threadId, yaml ?? existing?.yaml);
    const compiled = await this.compile(spec, cwd, threadId, () => undefined);
    const state = await compiled.getState(threadId);
    return { state };
  }

  async getHistory(threadId: string, yaml?: string): Promise<{ history: unknown[] }> {
    const existing = this.registry.get(threadId);
    const { spec, cwd } = await this.resolveSpec(threadId, yaml ?? existing?.yaml);
    const compiled = await this.compile(spec, cwd, threadId, () => undefined);
    const history = await compiled.getStateHistory(threadId);
    return { history };
  }

  async listRuns(): Promise<RunListItem[]> {
    const persisted = await listPersistedGraphs(this.config.graphStoreDir);
    const byId = new Map<string, RunListItem>();
    for (const meta of persisted) {
      const live = this.registry.get(meta.threadId);
      byId.set(meta.threadId, {
        threadId: meta.threadId,
        graphName: live?.graphName || meta.graphName || "graph",
        ...(meta.label || live?.label ? { label: live?.label ?? meta.label } : {}),
        status: live?.status ?? meta.status ?? "completed",
        updatedAt: meta.updatedAt,
        ...(live?.startedAt ? { startedAt: live.startedAt } : {}),
        active: Boolean(
          live && (live.status === "running" || live.status === "started"),
        ),
      });
    }
    for (const live of this.registry.list()) {
      if (byId.has(live.threadId)) continue;
      if (!live.runId) continue;
      byId.set(live.threadId, {
        threadId: live.threadId,
        graphName: live.graphName,
        ...(live.label ? { label: live.label } : {}),
        status: live.status,
        updatedAt: live.startedAt,
        startedAt: live.startedAt,
        active: live.status === "running" || live.status === "started",
      });
    }
    return [...byId.values()].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    );
  }

  async getRun(threadId: string): Promise<RunDetail | null> {
    const persisted = await loadPersistedGraph(this.config.graphStoreDir, threadId);
    const live = this.registry.get(threadId);
    if (!persisted && !live) return null;
    const meta = persisted?.meta;
    return {
      threadId,
      graphName: live?.graphName || meta?.graphName || persisted?.spec.metadata?.name || "graph",
      ...(live?.label || meta?.label ? { label: (live?.label || meta?.label) as string } : {}),
      status: live?.status ?? meta?.status ?? "completed",
      updatedAt: meta?.updatedAt ?? live?.startedAt ?? new Date().toISOString(),
      ...(live?.startedAt ? { startedAt: live.startedAt } : {}),
      active: Boolean(live && (live.status === "running" || live.status === "started")),
      yaml: persisted?.yaml ?? live?.yaml ?? "",
      issues: this.readIssues(threadId),
    };
  }

  listIssues(threadId: string): RunIssue[] {
    return this.readIssues(threadId);
  }

  /** In-memory events, or the on-disk journal after a process restart. */
  getJournal(threadId: string): ServerEvent[] {
    const live = this.registry.get(threadId);
    if (live && live.events.length > 0) return live.events;
    return loadEventJournal(this.config.graphStoreDir, threadId);
  }

  private readIssues(threadId: string): RunIssue[] {
    try {
      return readRunIssues(this.config.graphStoreDir, threadId);
    } catch {
      return [];
    }
  }
}
