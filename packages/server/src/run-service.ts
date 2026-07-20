import * as path from "node:path";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  compileGraph,
  resolveAndValidateInput,
  isInputValidationError,
  type CompiledGraph,
  type FlowgraphEvent,
  type RunResult,
} from "@veloxdevworks/flowgraph-core";
import { createPostgresCheckpointer } from "@veloxdevworks/flowgraph-checkpoint-postgres";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { rejectClientSecrets, applyServerCredentials } from "./credentials.js";
import { parseGraphYaml, persistGraph, loadPersistedGraph } from "./graph-source.js";
import { buildServerProviders } from "./providers.js";
import { SessionRegistry } from "./session-registry.js";
import { createMetrics, log } from "./metrics.js";
import type {
  ControlResult,
  GetStateResult,
  ServerConfig,
  StartRunRequest,
  StartRunResult,
  ResumeRunRequest,
} from "./types.js";

export class RunService {
  readonly registry: SessionRegistry;
  readonly metrics = createMetrics();
  private checkpointer: BaseCheckpointSaver | "memory" | null = null;
  private checkpointerPromise: Promise<BaseCheckpointSaver | "memory"> | null = null;

  constructor(readonly config: ServerConfig) {
    this.registry = new SessionRegistry(config.eventBufferSize);
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

  private async getCheckpointer(): Promise<BaseCheckpointSaver | "memory"> {
    if (this.checkpointer) return this.checkpointer;
    if (!this.checkpointerPromise) {
      this.checkpointerPromise = (async () => {
        if (this.config.databaseUrl) {
          const cp = await createPostgresCheckpointer(this.config.databaseUrl);
          this.checkpointer = cp;
          return cp;
        }
        // Let compileGraph create its own MemorySaver.
        this.checkpointer = "memory";
        return "memory";
      })();
    }
    return this.checkpointerPromise;
  }

  private async resolveSpec(
    threadId: string,
    yaml?: string,
  ): Promise<{ spec: GraphSpec; yaml: string; cwd: string }> {
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
    };
  }

  private async compile(
    spec: GraphSpec,
    cwd: string,
    threadId: string,
    onEvent: (ev: FlowgraphEvent) => void,
  ): Promise<CompiledGraph> {
    const checkpointer = await this.getCheckpointer();
    const providers = await buildServerProviders(spec, cwd);
    const graphPath = path.join(cwd, `${threadId.replace(/[^a-zA-Z0-9._-]/g, "_")}.graph.yaml`);
    return compileGraph(spec, {
      cwd,
      graphPath,
      ...(checkpointer === "memory" ? {} : { checkpointer }),
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

    const { spec, yaml, cwd } = await this.resolveSpec(req.threadId, req.yaml);
    const graphName = spec.metadata?.name ?? "graph";

    // Pre-create session so events during compile/run are buffered.
    const placeholder = this.registry.create({
      threadId: req.threadId,
      runId: "pending",
      graphName,
      ...(req.label ? { label: req.label } : {}),
      yaml,
    });

    const compiled = await this.compile(spec, cwd, req.threadId, (ev) => {
      this.registry.pushEvent(req.threadId, ev);
    });

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
        const message = err instanceof Error ? err.message : String(err);
        log("error", "run.error", { threadId: req.threadId, message });
        this.registry.setStatus(req.threadId, "error");
        this.metrics.recordResult("error");
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

  private applyResult(threadId: string, result: RunResult): void {
    const status =
      result.status === "interrupted"
        ? "interrupted"
        : result.status === "paused"
          ? "paused"
          : result.status === "error"
            ? "error"
            : "completed";
    this.registry.setStatus(threadId, status);
    this.metrics.recordResult(result.status);
    log("info", "run.end", { threadId, status: result.status, runId: result.runId });
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

    const compiled = await this.compile(spec, cwd, req.threadId, (ev) => {
      this.registry.pushEvent(req.threadId, ev);
    });
    session.runId = compiled.runId;
    this.registry.setStatus(req.threadId, "running");

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
        const message = err instanceof Error ? err.message : String(err);
        log("error", "resume.error", { threadId: req.threadId, message });
        this.registry.setStatus(req.threadId, "error");
        this.metrics.recordResult("error");
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
    return { threadId, runId: session.runId, status: "cancelled" };
  }

  async pauseRun(threadId: string): Promise<ControlResult> {
    const session = this.registry.get(threadId);
    if (!session) throw new Error(`No active session for thread "${threadId}"`);
    session.pause.abort();
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

    const compiled = await this.compile(spec, cwd, threadId, (ev) => {
      this.registry.pushEvent(threadId, ev);
    });
    session.runId = compiled.runId;
    this.registry.setStatus(threadId, "running");

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
        const message = err instanceof Error ? err.message : String(err);
        log("error", "continue.error", { threadId, message });
        this.registry.setStatus(threadId, "error");
        this.metrics.recordResult("error");
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
}
