import * as path from "node:path";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  compileGraph,
  createInMemoryMemoryBackend,
  startMemorySweeper,
  resolveAndValidateInput,
  isInputValidationError,
  readRunIssues,
  createInMemoryGraphNameRegistry,
  createInMemoryThreadOwnerRegistry,
  type CompiledGraph,
  type FlowgraphEvent,
  type GraphNameRegistry,
  type ThreadOwnerRegistry,
  type MemoryBackend,
  type MemoryIdentity,
  type MemorySweeper,
  type RunIssue,
  type RunResult,
  MEMORY_SWEEP_MAX_INTERVAL_MS,
} from "@flowgraph/core";
import { maybeSweepPostgres, openPostgresBackend } from "@flowgraph/checkpoint-postgres";
import type { GraphSpec } from "@flowgraph/spec";
import { rejectClientSecrets, applyServerCredentials } from "./credentials.js";
import {
  parseGraphYaml,
  persistGraph,
  loadPersistedGraph,
  readPersistedGraphYaml,
  readGraphMeta,
  updateGraphMeta,
  listPersistedGraphs,
  appendEventJournal,
  loadEventJournal,
} from "./graph-source.js";
import { buildServerProviders } from "./providers.js";
import { SessionRegistry } from "./session-registry.js";
import { createMetrics, errorFields, log } from "./metrics.js";
import type {
  ControlResult,
  GetStateResult,
  RunDetail,
  RunListItem,
  GraphMeta,
  RunStatus,
  ServerConfig,
  ServerEvent,
  ThreadOwner,
  StartRunRequest,
  StartRunResult,
  ResumeRunRequest,
} from "./types.js";

import { ServerRequestError, TooManyRunsError } from "./errors.js";
import { assertUntrustedUploadAllowed, untrustedNodePolicy, type UntrustedUploadOptions } from "./upload-policy.js";
import { authModeOf, createAuthenticator, singleUserPrincipal, type Authenticator, type Principal } from "./identity.js";

/** sqlite memory is optional: the package is loaded only when configured. */
async function loadSqlite(): Promise<typeof import("@flowgraph/checkpoint-sqlite")> {
  try {
    return await import("@flowgraph/checkpoint-sqlite");
  } catch (err) {
    throw new Error(
      `FLOWGRAPH_MEMORY_BACKEND=sqlite needs @flowgraph/checkpoint-sqlite: pnpm add @flowgraph/checkpoint-sqlite (${(err as Error).message})`,
    );
  }
}

const SERVER_MEMORY_HINT =
  "Start the server with FLOWGRAPH_MEMORY_BACKEND=postgres (memory shares DATABASE_URL) or FLOWGRAPH_MEMORY_BACKEND=sqlite, " +
  "plus FLOWGRAPH_ORG.";

/** How long close() waits for runs in flight before aborting them. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
/** How long aborted runs get to settle before pools are closed anyway. */
const SHUTDOWN_ABORT_GRACE_MS = 2_000;
/** Per pool or store, how long shutdown waits for it to close. */
const SHUTDOWN_CLOSE_TIMEOUT_MS = 5_000;

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
  /** Durable memory for graphs that declare runtime.memory (config.memory.backend postgres | sqlite). */
  private durableMemory: { backend: MemoryBackend } | undefined;
  /** Graph-name ownership: next to durable memory when configured, else process-local. */
  private graphNames: GraphNameRegistry | undefined;
  /**
   * Thread ownership, stored with the checkpoints: Postgres when DATABASE_URL
   * is set, else the sqlite memory file, else process memory (where the
   * in-memory checkpoints live too).
   */
  private threadOwners: ThreadOwnerRegistry | undefined;
  private singleUser: Principal | undefined;
  private sweeper: MemorySweeper | undefined;
  private closers: Array<() => Promise<void> | void> = [];
  private auth: Authenticator | undefined;
  /** Set by close(): new runs and graph reads are refused from then on. */
  private closing = false;
  private closed: Promise<void> | undefined;
  /** Requests being set up and runs executing, which close() waits for. */
  private readonly inFlight = new Set<Promise<unknown>>();

  /** Resolves callers to principals (OIDC, the legacy token, or none), built from config.auth. */
  get authenticator(): Authenticator {
    this.auth ??= createAuthenticator(this.config);
    return this.auth;
  }

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
    const memBackend = config.memory?.backend ?? "memory";
    const sweepMs = config.memory?.sweepIntervalMs;
    if (sweepMs !== undefined && !(Number.isInteger(sweepMs) && sweepMs >= 1_000 && sweepMs <= MEMORY_SWEEP_MAX_INTERVAL_MS)) {
      throw new Error(`memory.sweepIntervalMs must be a whole number of milliseconds from 1000 to ${MEMORY_SWEEP_MAX_INTERVAL_MS} (got ${sweepMs})`);
    }
    // With OIDC each caller's token names its org; single-user servers need FLOWGRAPH_ORG.
    if (memBackend !== "memory" && authModeOf(config) !== "oidc" && !config.memory?.identity?.org?.trim()) {
      throw new Error(
        `FLOWGRAPH_MEMORY_BACKEND=${memBackend} needs FLOWGRAPH_ORG: durable memory on the server is owned by one org ` +
          "(and FLOWGRAPH_PROJECT, default \"local\"). Set FLOWGRAPH_ORG, or unset FLOWGRAPH_MEMORY_BACKEND to keep " +
          "process-local memory. Local use with the flowgraph CLI needs neither.",
      );
    }
  }

  async init(): Promise<void> {
    await this.getCheckpointer();
    log("info", "run-service ready", {
      database: this.config.databaseUrl ? "postgres" : "memory",
      memory: this.config.memory?.backend ?? "memory",
      graphStoreDir: this.config.graphStoreDir,
    });
  }

  /**
   * Shut down: refuse new runs (503 SERVER_CLOSING), wait up to
   * `shutdownTimeoutMs` for requests and runs in flight, abort what is still
   * running and give it a moment to settle, then stop the memory sweeper and
   * close durable memory and database pools. Safe to call more than once.
   */
  close(): Promise<void> {
    this.closed ??= this.shutdown();
    return this.closed;
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    this.sweeper?.stop();
    this.sweeper = undefined;
    const timeoutMs = this.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (!(await this.drain(timeoutMs))) {
      const running = this.registry.list().filter((s) => s.status === "running" || s.status === "started");
      log("warn", "shutdown.abort", { runs: running.length, timeoutMs });
      for (const s of running) s.abort.abort(new Error("server is shutting down"));
      if (!(await this.drain(SHUTDOWN_ABORT_GRACE_MS))) {
        log("warn", "shutdown.unsettled", { pending: this.inFlight.size });
      }
    }
    const closeMs = this.config.closeTimeoutMs ?? SHUTDOWN_CLOSE_TIMEOUT_MS;
    for (const c of this.closers.splice(0).reverse()) {
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        Promise.resolve()
          .then(c)
          .then(
            () => "closed" as const,
            (err: unknown) => {
              log("warn", "shutdown.close_failed", errorFields(err));
              return "failed" as const;
            },
          ),
        new Promise<"timeout">((r) => {
          timer = setTimeout(() => r("timeout"), closeMs);
        }),
      ]);
      clearTimeout(timer);
      if (outcome === "timeout") log("warn", "shutdown.close_timeout", { timeoutMs: closeMs });
    }
  }

  /** True when everything in flight (including work started meanwhile) settled within `ms`. */
  private async drain(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.inFlight.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.allSettled([...this.inFlight]).then(() => false),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), left);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) return false;
    }
    return true;
  }

  private assertOpen(): void {
    if (this.closing) throw new ServerRequestError(503, "SERVER_CLOSING", "The server is shutting down; retry against another instance");
  }

  /** Keep `work` in flight until it settles; close() waits for it. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    const done = () => this.inFlight.delete(work);
    work.then(done, done);
    return work;
  }

  private get uploadOptions(): UntrustedUploadOptions {
    return {
      ...(this.config.untrustedHttpAllowHosts ? { allowHosts: this.config.untrustedHttpAllowHosts } : {}),
      ...(this.config.untrustedAllowTools ? { allowTools: this.config.untrustedAllowTools } : {}),
      ...(this.config.untrustedAllowFunctions ? { allowFunctions: this.config.untrustedAllowFunctions } : {}),
    };
  }

  /** True when callers are told apart (OIDC); token and none modes have one principal. */
  get multiUser(): boolean {
    return authModeOf(this.config) === "oidc";
  }

  /** The caller, or the single-user principal when the server has only one. */
  principalFor(principal?: Principal): Principal {
    if (principal) return principal;
    if (this.multiUser) throw new ServerRequestError(401, "AUTH_REQUIRED", "This server identifies callers with OIDC: send an access token");
    this.singleUser ??= singleUserPrincipal(this.config);
    return this.singleUser;
  }

  /**
   * Memory identity for a caller. Multi-user servers scope memory to the token's org,
   * project and subject, and bind threads to the principal; single-user servers keep
   * FLOWGRAPH_ORG / FLOWGRAPH_PROJECT / FLOWGRAPH_USER.
   */
  memoryIdentityFor(principal: Principal): MemoryIdentity | undefined {
    if (this.multiUser) {
      return { org: principal.org, project: principal.project ?? "local", user: principal.subject, principalId: principal.id };
    }
    const id = this.config.memory?.identity;
    if (!id?.org?.trim()) return undefined;
    return { org: id.org, project: id.project, ...(id.user ? { user: id.user } : {}) };
  }

  private ownerOf(principal: Principal): ThreadOwner {
    return { id: principal.id, org: principal.org };
  }

  /**
   * Refuse a thread another principal created. Only multi-user servers check.
   * The owner comes from the thread-owner registry stored with the
   * checkpoints, so every replica sharing them agrees, and a lost or wiped
   * graph store does not hand a thread to a new caller. A thread with stored
   * state but no recorded owner is refused, as is any call when the owner
   * cannot be looked up.
   */
  private async checkThreadAccess(
    threadId: string,
    principal: Principal,
    opts: { mustExist?: boolean } = {},
  ): Promise<GraphMeta | null> {
    const meta = await readGraphMeta(this.config.graphStoreDir, threadId);
    const collides = Boolean(meta && meta.threadId !== threadId);
    if (!this.multiUser) {
      if (collides) throw this.threadIdConflict(threadId, meta!);
      return meta;
    }
    const notOwned = () => new ServerRequestError(403, "THREAD_NOT_OWNED", `Thread "${threadId}" belongs to another user`);
    const registry = await this.threadOwnerRegistry();
    const record = await this.ownerLookup(threadId, () => registry.get(threadId));
    if (record) {
      if (record.owner !== principal.id) throw notOwned();
    }
    if (collides) {
      // Thread ids map to file names with unsafe characters replaced ("a/b"
      // and "a_b"). Name the other thread only to its owner.
      if (meta!.owner?.id !== principal.id) throw notOwned();
      throw this.threadIdConflict(threadId, meta!);
    }
    if (record) return meta;
    const live = this.registry.get(threadId);
    const legacy = meta?.owner ?? live?.owner;
    if (legacy) {
      if (legacy.id !== principal.id) throw notOwned();
      // Owner known only from this replica's graph store: record it with the checkpoints.
      const claim = await this.ownerLookup(threadId, () => registry.claim(threadId, legacy.id, legacy.org ?? ""));
      if (claim.owner !== principal.id) throw notOwned();
      return meta;
    }
    if (meta || (live && live.runId)) {
      throw new ServerRequestError(
        403,
        "THREAD_NOT_OWNED",
        `Thread "${threadId}" has no recorded owner (it was stored before this server identified callers); use a new thread id`,
      );
    }
    // No owner anywhere: refuse ids that already have saved state (stored
    // before owners were recorded, or by a host without this registry).
    const checkpointer = await this.ownerLookup(threadId, () => this.getCheckpointer());
    const saved = await this.ownerLookup(threadId, () => checkpointer.getTuple({ configurable: { thread_id: threadId } }));
    if (saved) {
      throw new ServerRequestError(
        403,
        "THREAD_NOT_OWNED",
        `Thread "${threadId}" has saved state but no recorded owner; use a new thread id`,
      );
    }
    if (opts.mustExist) throw new ServerRequestError(404, "THREAD_NOT_FOUND", `No run "${threadId}"`);
    return null;
  }

  private threadIdConflict(threadId: string, meta: GraphMeta): ServerRequestError {
    return new ServerRequestError(
      409,
      "THREAD_ID_CONFLICT",
      `Thread id "${threadId}" collides with stored thread "${meta.threadId}"; use another id`,
    );
  }

  /**
   * Update a thread's meta file in the background. The file can be gone (a
   * wiped graph store, or a test removing its directory); that must not
   * become an unhandled rejection.
   */
  private patchMeta(threadId: string, patch: Parameters<typeof updateGraphMeta>[2]): void {
    updateGraphMeta(this.config.graphStoreDir, threadId, patch).catch((err: unknown) => {
      log("warn", "graph meta update failed", { threadId, ...errorFields(err) });
    });
  }

  /** Run an owner lookup; any failure refuses the call rather than guessing. */
  private async ownerLookup<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ServerRequestError) throw err;
      log("error", "thread owner lookup failed", { threadId, ...errorFields(err) });
      throw new ServerRequestError(503, "THREAD_OWNER_UNAVAILABLE", `Cannot check who owns thread "${threadId}" right now; try again`);
    }
  }

  /** The thread-owner registry, opening the checkpoint store first so a durable one is used when configured. */
  private async threadOwnerRegistry(): Promise<ThreadOwnerRegistry> {
    if (!this.threadOwners) await this.ownerLookup("*", () => this.getCheckpointer());
    this.threadOwners ??= createInMemoryThreadOwnerRegistry();
    return this.threadOwners;
  }

  /** Record the caller as the owner of a new thread; refuse when another caller won the claim. */
  private async claimThread(threadId: string, principal: Principal): Promise<void> {
    if (!this.multiUser) return;
    const registry = await this.threadOwnerRegistry();
    const claim = await this.ownerLookup(threadId, () => registry.claim(threadId, principal.id, principal.org ?? ""));
    if (claim.owner !== principal.id) {
      throw new ServerRequestError(403, "THREAD_NOT_OWNED", `Thread "${threadId}" belongs to another user`);
    }
  }

  /** Check a caller may watch a thread's events (multi-user servers refuse unknown threads). */
  async authorizeEvents(threadId: string, principal?: Principal): Promise<void> {
    await this.checkThreadAccess(threadId, this.principalFor(principal), { mustExist: true });
  }

  private graphNameRegistry(): GraphNameRegistry {
    if (!this.graphNames) {
      this.graphNames = createInMemoryGraphNameRegistry();
      if (this.multiUser) {
        log("warn", "graph-names.process-local", {
          message:
            "Graph-name ownership is kept in memory and resets on restart, and replicas do not share it; set DATABASE_URL (or FLOWGRAPH_MEMORY_BACKEND=sqlite for one replica) to store it durably.",
        });
      }
    }
    return this.graphNames;
  }

  /**
   * On multi-user servers a graph name belongs to the first principal in its
   * org that uploads it. The spec only admits lower-case ASCII kebab-case
   * names, so case or Unicode look-alikes of a name cannot be registered.
   */
  private async claimGraphName(spec: GraphSpec, principal: Principal): Promise<void> {
    if (!this.multiUser) return;
    const name = spec.metadata?.name ?? "graph";
    const claim = await this.graphNameRegistry().claim(principal.org, name, principal.id);
    if (claim.owner !== principal.id) {
      throw new ServerRequestError(
        409,
        "GRAPH_NAME_TAKEN",
        `Graph name "${name}" is registered to another user in org "${principal.org}"; rename metadata.name`,
      );
    }
  }

  private useDurableMemory(backend: MemoryBackend, sweep?: (intervalMs: number, now: number) => Promise<number>): void {
    this.durableMemory = { backend };
    const intervalMs = this.config.memory?.sweepIntervalMs ?? 3_600_000;
    this.sweeper = startMemorySweeper(backend, {
      intervalMs,
      ...(sweep ? { sweep: (now: number) => sweep(intervalMs, now) } : {}),
      onError: (err) => log("warn", "memory sweep failed", errorFields(err)),
    });
  }

  private async getCheckpointer(): Promise<BaseCheckpointSaver> {
    if (this.checkpointer) return this.checkpointer;
    if (!this.checkpointerPromise) {
      this.checkpointerPromise = (async () => {
        const memBackend = this.config.memory?.backend ?? "memory";
        if (memBackend === "postgres" && !this.config.databaseUrl) {
          throw new Error("FLOWGRAPH_MEMORY_BACKEND=postgres needs DATABASE_URL (memory shares the checkpoint database)");
        }
        if (memBackend === "sqlite") {
          const sqlite = await loadSqlite();
          const file = this.config.memory?.sqlitePath ?? path.join(this.config.graphStoreDir, "memory.db");
          const b = await sqlite.openSqliteBackend(file);
          this.closers.push(() => b.close());
          this.useDurableMemory(b.memory);
          this.graphNames = b.graphNames;
          this.threadOwners = b.threadOwners;
        }
        if (this.config.databaseUrl) {
          // One pool for checkpoints, thread owners and graph names (and
          // memory when FLOWGRAPH_MEMORY_BACKEND=postgres), so every replica
          // sharing the checkpoints shares who owns them.
          const pg = await openPostgresBackend({
            connectionString: this.config.databaseUrl,
            ...(this.config.setupLockTimeoutMs !== undefined ? { setupLockTimeoutMs: this.config.setupLockTimeoutMs } : {}),
            onPoolError: (err) => log("warn", "postgres idle connection error", errorFields(err)),
          });
          this.closers.push(() => pg.close());
          if (memBackend === "postgres") {
            // Replicas share the database: each interval is claimed by one of
            // them (a little early, so timer drift never skips an interval).
            this.useDurableMemory(pg.memory, (intervalMs, now) => maybeSweepPostgres(pg.memory, intervalMs * 0.9, now));
          }
          this.graphNames = pg.graphNames;
          this.threadOwners = pg.threadOwners;
          this.checkpointer = pg.checkpointer;
          return pg.checkpointer;
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
    yaml: string | undefined,
    principal: Principal,
    extras: { label?: string; status?: RunStatus } = {},
  ): Promise<{ spec: GraphSpec; yaml: string; cwd: string; importsStripped: boolean }> {
    if (yaml) {
      // Untrusted uploads never see the server environment.
      const parsed = parseGraphYaml(yaml, { expandEnv: principal.trusted });
      if (!parsed.spec) {
        const msg = parsed.diagnostics.map((d) => d.message).join("; ");
        throw new Error(`Invalid graph YAML: ${msg}`);
      }
      if (!principal.trusted) assertUntrustedUploadAllowed(yaml, parsed.spec, this.uploadOptions);
      if (parsed.importsStripped) {
        log("warn", "stripped client imports from uploaded graph", { threadId });
      }
      await this.claimGraphName(parsed.spec, principal);
      // Store and hand back the YAML as uploaded: expanded values never reach
      // the graph store, the session or getRun, and are filled again per run.
      await persistGraph(this.config.graphStoreDir, threadId, yaml, parsed.spec, {
        ...extras,
        owner: this.ownerOf(principal),
        yamlFormat: "raw",
      });
      return {
        spec: parsed.spec,
        yaml,
        cwd: this.config.graphStoreDir,
        importsStripped: parsed.importsStripped,
      };
    }

    const persisted = await loadPersistedGraph(this.config.graphStoreDir, threadId, { expandEnv: principal.trusted });
    if (!persisted) {
      throw new Error(
        `No persisted graph for thread "${threadId}". Provide yaml on start/resume.`,
      );
    }
    // Trust is checked again on every run: the author may have lost it since the upload.
    if (!principal.trusted) assertUntrustedUploadAllowed(persisted.yaml, persisted.spec, this.uploadOptions);
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
    principal: Principal,
    dryRun = false,
  ): Promise<CompiledGraph> {
    const checkpointer = await this.getCheckpointer();
    const providers = await buildServerProviders(spec, cwd, { dryRun, untrusted: !principal.trusted });
    const identity = this.memoryIdentityFor(principal);
    const graphPath = path.join(cwd, `${threadId.replace(/[^a-zA-Z0-9._-]/g, "_")}.graph.yaml`);
    return compileGraph(spec, {
      cwd,
      graphPath,
      checkpointer,
      legacyStoreBackend: this.legacyStoreBackend,
      ...(identity ? { memoryIdentity: identity } : {}),
      ...(principal.trusted ? {} : { nodePolicy: untrustedNodePolicy(this.uploadOptions) }),
      ...(this.durableMemory && identity
        ? { memory: { backend: this.durableMemory.backend, identity } }
        : { memoryUnavailableHint: SERVER_MEMORY_HINT }),
      providers,
      sinks: [
        (event) => {
          onEvent(event);
        },
      ],
    });
  }

  startRun(req: StartRunRequest, caller?: Principal): Promise<StartRunResult> {
    try {
      this.assertOpen();
    } catch (err) {
      return Promise.reject(err);
    }
    return this.track(this.startRunNow(req, caller));
  }

  private async startRunNow(req: StartRunRequest, caller?: Principal): Promise<StartRunResult> {
    rejectClientSecrets(req.env);
    if (!req.threadId?.trim()) throw new Error("threadId is required");
    if (!req.yaml?.trim()) throw new Error("yaml is required");
    const principal = this.principalFor(caller);
    await this.checkThreadAccess(req.threadId, principal);
    await this.claimThread(req.threadId, principal);

    const max = this.config.maxConcurrentRuns ?? 16;
    if (max > 0 && this.registry.activeCount() >= max) {
      throw new TooManyRunsError(max);
    }

    const { spec, yaml, cwd, importsStripped } = await this.resolveSpec(req.threadId, req.yaml, principal, {
      ...(req.label ? { label: req.label } : {}),
      status: "running",
    });
    const graphName = spec.metadata?.name ?? "graph";

    // Pre-create session so events during compile/run are buffered.
    const placeholder = this.registry.create({
      threadId: req.threadId,
      runId: "pending",
      graphName,
      ...(req.label ? { label: req.label } : {}),
      yaml,
      ...(req.dryRun ? { dryRun: true } : {}),
      owner: this.ownerOf(principal),
    });

    let compiled: CompiledGraph;
    try {
      compiled = await this.compile(spec, cwd, req.threadId, (ev) => {
        this.registry.pushEvent(req.threadId, ev);
      }, principal, Boolean(req.dryRun));
    } catch (err) {
      // Don't leave a "running" placeholder behind for a run that never started.
      if (this.registry.get(req.threadId) === placeholder) this.registry.remove(req.threadId);
      this.patchMeta(req.threadId, { status: "error" });
      throw err;
    }

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

    void this.track((async () => {
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
        this.patchMeta(req.threadId, { status: "error" });
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
    })());

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
    this.patchMeta(threadId, { status });
  }

  resumeRun(req: ResumeRunRequest, caller?: Principal): Promise<ControlResult> {
    try {
      this.assertOpen();
    } catch (err) {
      return Promise.reject(err);
    }
    return this.track(this.resumeRunNow(req, caller));
  }

  private async resumeRunNow(req: ResumeRunRequest, caller?: Principal): Promise<ControlResult> {
    if (!req.threadId?.trim()) throw new Error("threadId is required");
    const principal = this.principalFor(caller);
    await this.checkThreadAccess(req.threadId, principal, { mustExist: true });

    const existing = this.registry.get(req.threadId);
    const yaml = req.yaml ?? existing?.yaml;
    const { spec, yaml: resolvedYaml, cwd } = await this.resolveSpec(req.threadId, yaml, principal);
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
        owner: this.ownerOf(principal),
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
      principal,
      dryRun,
    );
    session.runId = compiled.runId;
    session.dryRun = dryRun;
    this.registry.setStatus(req.threadId, "running");
    this.patchMeta(req.threadId, { status: "running" });

    // Fire-and-forget like start/continue — resumed execution can be long-running.
    void this.track((async () => {
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
        this.patchMeta(req.threadId, { status: "error" });
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
    })());

    return {
      threadId: req.threadId,
      runId: compiled.runId,
      status: "started",
    };
  }

  async cancelRun(threadId: string, caller?: Principal): Promise<ControlResult> {
    await this.checkThreadAccess(threadId, this.principalFor(caller), { mustExist: true });
    const session = this.registry.get(threadId);
    if (!session) throw new Error(`No active session for thread "${threadId}"`);
    session.abort.abort();
    this.registry.setStatus(threadId, "cancelled");
    this.metrics.recordResult("cancelled");
    this.patchMeta(threadId, { status: "cancelled" });
    return { threadId, runId: session.runId, status: "cancelled" };
  }

  async pauseRun(threadId: string, caller?: Principal): Promise<ControlResult> {
    await this.checkThreadAccess(threadId, this.principalFor(caller), { mustExist: true });
    const session = this.registry.get(threadId);
    if (!session) throw new Error(`No active session for thread "${threadId}"`);
    session.pause.abort();
    this.patchMeta(threadId, { status: "paused" });
    return { threadId, runId: session.runId, status: "started" };
  }

  continueRun(threadId: string, yaml?: string, caller?: Principal): Promise<ControlResult> {
    try {
      this.assertOpen();
    } catch (err) {
      return Promise.reject(err);
    }
    return this.track(this.continueRunNow(threadId, yaml, caller));
  }

  private async continueRunNow(threadId: string, yaml?: string, caller?: Principal): Promise<ControlResult> {
    const principal = this.principalFor(caller);
    await this.checkThreadAccess(threadId, principal, { mustExist: true });
    const existing = this.registry.get(threadId);
    const { spec, yaml: resolvedYaml, cwd } = await this.resolveSpec(threadId, yaml ?? existing?.yaml, principal);

    const abort = new AbortController();
    const pause = new AbortController();
    let session = this.registry.get(threadId);
    if (!session) {
      session = this.registry.create({
        threadId,
        runId: "pending",
        graphName: spec.metadata?.name ?? "graph",
        yaml: resolvedYaml,
        owner: this.ownerOf(principal),
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
      principal,
      dryRun,
    );
    session.runId = compiled.runId;
    session.dryRun = dryRun;
    this.registry.setStatus(threadId, "running");
    this.patchMeta(threadId, { status: "running" });

    // Fire-and-forget like start (continue can be long-running)
    void this.track((async () => {
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
        this.patchMeta(threadId, { status: "error" });
      }
    })());

    return { threadId, runId: compiled.runId, status: "started" };
  }

  getState(threadId: string, yaml?: string, caller?: Principal): Promise<GetStateResult> {
    try {
      this.assertOpen();
    } catch (err) {
      return Promise.reject(err);
    }
    return this.track(this.getStateNow(threadId, yaml, caller));
  }

  private async getStateNow(threadId: string, yaml?: string, caller?: Principal): Promise<GetStateResult> {
    const principal = this.principalFor(caller);
    await this.checkThreadAccess(threadId, principal, { mustExist: true });
    const existing = this.registry.get(threadId);
    const { spec, cwd } = await this.resolveSpec(threadId, yaml ?? existing?.yaml, principal);
    const compiled = await this.compile(spec, cwd, threadId, () => undefined, principal);
    const state = await compiled.getState(threadId);
    return { state };
  }

  getHistory(threadId: string, yaml?: string, caller?: Principal): Promise<{ history: unknown[] }> {
    try {
      this.assertOpen();
    } catch (err) {
      return Promise.reject(err);
    }
    return this.track(this.getHistoryNow(threadId, yaml, caller));
  }

  private async getHistoryNow(threadId: string, yaml?: string, caller?: Principal): Promise<{ history: unknown[] }> {
    const principal = this.principalFor(caller);
    await this.checkThreadAccess(threadId, principal, { mustExist: true });
    const existing = this.registry.get(threadId);
    const { spec, cwd } = await this.resolveSpec(threadId, yaml ?? existing?.yaml, principal);
    const compiled = await this.compile(spec, cwd, threadId, () => undefined, principal);
    const history = await compiled.getStateHistory(threadId);
    return { history };
  }

  async listRuns(caller?: Principal): Promise<RunListItem[]> {
    const principal = this.principalFor(caller);
    // Multi-user servers list only the caller's threads.
    const mine = (owner: ThreadOwner | undefined) => !this.multiUser || owner?.id === principal.id;
    const persisted = await listPersistedGraphs(this.config.graphStoreDir);
    const byId = new Map<string, RunListItem>();
    for (const meta of persisted) {
      if (!mine(meta.owner)) continue;
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
      if (!mine(live.owner)) continue;
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

  async getRun(threadId: string, caller?: Principal): Promise<RunDetail | null> {
    await this.checkThreadAccess(threadId, this.principalFor(caller));
    const persisted = await readPersistedGraphYaml(this.config.graphStoreDir, threadId);
    const live = this.registry.get(threadId);
    if (!persisted && !live) return null;
    const meta = persisted?.meta;
    return {
      threadId,
      graphName: live?.graphName || meta?.graphName || "graph",
      ...(live?.label || meta?.label ? { label: (live?.label || meta?.label) as string } : {}),
      status: live?.status ?? meta?.status ?? "completed",
      updatedAt: meta?.updatedAt ?? live?.startedAt ?? new Date().toISOString(),
      ...(live?.startedAt ? { startedAt: live.startedAt } : {}),
      active: Boolean(live && (live.status === "running" || live.status === "started")),
      yaml: persisted?.yaml ?? live?.yaml ?? "",
      issues: this.readIssues(threadId),
    };
  }

  async listIssues(threadId: string, caller?: Principal): Promise<RunIssue[]> {
    await this.checkThreadAccess(threadId, this.principalFor(caller));
    return this.readIssues(threadId);
  }

  /** In-memory events, or the on-disk journal after a process restart. */
  async getJournal(threadId: string, caller?: Principal): Promise<ServerEvent[]> {
    await this.checkThreadAccess(threadId, this.principalFor(caller));
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
