/**
 * Per-compiled-graph memory runtime: owns the backend, the host identity, the
 * policy derived from `runtime.memory`, and per-thread scope bindings.
 * Shared (by reference) with embedded subgraphs so they read and write the
 * root graph's scopes.
 */
import { renderDeep } from "@flowgraph/expr";
import { replayNodeKey, runScopeOf } from "../providers/replay-cache.js";
import { parseDuration } from "../runtime/duration.js";
import { createInMemoryMemoryBackend } from "./in-memory.js";
import { createScopedMemory, defaultMemoryPolicy, type LegacyWriteCursor, type MemoryOpSource, type MemoryPolicy, type ScopedMemory } from "./handle.js";
import { LegacyScopedStore } from "./legacy-store.js";
import { normalizeSubjectKey, tupleForScope, type MemoryBinding } from "./scope.js";
import {
  MemoryError,
  MEMORY_HARD_CAPS,
  type MemoryBackend,
  type MemoryIdentity,
  type MemoryLimits,
  type MemoryThreadBinding,
} from "./types.js";

function bindingOf(stored: MemoryThreadBinding): MemoryBinding {
  return {
    org: stored.org,
    project: stored.project,
    graph: stored.graph,
    user: stored.usr,
    ...(stored.subjectType ? { subject: { type: stored.subjectType, key: stored.subjectKey } } : {}),
  };
}

const describeSubject = (b: Pick<MemoryThreadBinding, "subjectType" | "subjectKey">): string =>
  b.subjectType ? `${b.subjectType}:${b.subjectKey}` : "(none)";

/** Parsed `runtime.memory` block (mirrors the spec schema). */
export interface RuntimeMemoryConfig {
  backend?: "checkpoint" | "memory" | undefined;
  subject?:
    | {
        type: string;
        key: string;
        required?: boolean | undefined;
        ttl?: string | undefined;
        hash?: boolean | undefined;
      }
    | undefined;
  limits?:
    | {
        itemBytes?: number | undefined;
        itemsPerScope?: number | undefined;
        bytesPerScope?: number | undefined;
        subjectsPerType?: number | undefined;
        onFull?: "evict-oldest" | "reject" | undefined;
      }
    | undefined;
}

/** Symbol under which a run context carries its MemoryRuntime (for embedded subgraphs). */
export const MEMORY_RUNTIME: unique symbol = Symbol.for("flowgraph.memoryRuntime");

export const LOCAL_MEMORY_IDENTITY: MemoryIdentity = { org: "local", project: "local" };

function cap(n: number | undefined, max: number): number | undefined {
  return n === undefined ? undefined : Math.min(n, max);
}

export function memoryPolicyFromConfig(cfg: RuntimeMemoryConfig | undefined): MemoryPolicy {
  const p = defaultMemoryPolicy();
  const l = cfg?.limits;
  if (l) {
    const over: Partial<MemoryLimits> = {};
    const itemBytes = cap(l.itemBytes, MEMORY_HARD_CAPS.itemBytes);
    const items = cap(l.itemsPerScope, MEMORY_HARD_CAPS.itemsPerScope);
    const bytes = cap(l.bytesPerScope, MEMORY_HARD_CAPS.bytesPerScope);
    const subjects = cap(l.subjectsPerType, MEMORY_HARD_CAPS.subjectsPerType);
    if (itemBytes !== undefined) over.itemBytes = itemBytes;
    if (l.onFull !== undefined) over.onFull = l.onFull;
    if (subjects !== undefined) over.subjectsPerType = subjects;
    p.limits = { ...p.limits, ...over };
    p.subjectLimits = { ...p.subjectLimits, ...over };
    if (items !== undefined) p.limits.itemsPerScope = items;
    if (bytes !== undefined) p.limits.bytesPerScope = bytes;
  }
  if (cfg?.subject?.ttl) p.subjectTtlMs = parseDuration(cfg.subject.ttl);
  if (cfg?.subject?.type) p.subjectType = cfg.subject.type;
  return p;
}

export interface MemoryRuntimeInit {
  backend: MemoryBackend;
  identity: MemoryIdentity;
  /** Root graph name. */
  graph: string;
  config?: RuntimeMemoryConfig | undefined;
  /** Whether nodes get `ctx.memory` (runtime.memory declared, or a durable runtime.store alias). */
  exposeMemory: boolean;
}

export class MemoryRuntime {
  readonly backend: MemoryBackend;
  readonly identity: MemoryIdentity;
  readonly graph: string;
  readonly config: RuntimeMemoryConfig | undefined;
  readonly exposeMemory: boolean;
  readonly policy: MemoryPolicy;
  private readonly bindings = new Map<string, MemoryBinding>();
  private legacy: LegacyScopedStore | undefined;

  constructor(init: MemoryRuntimeInit) {
    this.backend = init.backend;
    this.identity = init.identity;
    this.graph = init.graph;
    this.config = init.config;
    this.exposeMemory = init.exposeMemory;
    this.policy = memoryPolicyFromConfig(init.config);
  }

  baseBinding(): MemoryBinding {
    return {
      org: this.identity.org,
      project: this.identity.project,
      graph: this.graph,
      user: this.identity.user ?? "",
    };
  }

  /**
   * Bind a thread at run start (renders the subject from input/run), or reload
   * the stored binding on resume/continue so a resume can't switch scope.
   */
  async beginRun(
    threadId: string,
    mode: "start" | "resume" | "continue",
    scope: { input: unknown; run: unknown },
  ): Promise<MemoryBinding | undefined> {
    if (!this.exposeMemory) return undefined;
    if (mode !== "start") {
      const cached = this.bindings.get(threadId);
      if (cached) return cached;
      const stored = await this.backend.getThread(threadId);
      if (stored) {
        // A resume keeps the thread's scopes, but only for the identity that started it.
        this.checkOwner(threadId, stored, mode);
        const b = bindingOf(stored);
        this.bindings.set(threadId, b);
        return b;
      }
    }
    const binding = this.baseBinding();
    const s = this.config?.subject;
    if (s) {
      const raw = renderDeep(s.key, scope as Record<string, unknown>);
      const key = normalizeSubjectKey(raw, { hash: s.hash ?? false });
      if (key) binding.subject = { type: s.type, key };
      else if (s.required) {
        throw new MemoryError(
          "MEMORY_SUBJECT_UNRESOLVED",
          `runtime.memory.subject.key ${JSON.stringify(s.key)} rendered empty for this run (subject "${s.type}" is required)`,
        );
      }
    }
    const want: MemoryThreadBinding = {
      threadId,
      org: binding.org,
      project: binding.project,
      graph: binding.graph,
      usr: binding.user,
      subjectType: binding.subject?.type ?? "",
      subjectKey: binding.subject?.key ?? "",
      principalId: this.identity.principalId ?? null,
    };
    // Insert-only: an existing thread keeps its binding. Re-read to detect a
    // thread id that is already bound to another identity or subject.
    await this.backend.bindThread(want);
    const stored = await this.backend.getThread(threadId);
    if (stored) {
      this.checkOwner(threadId, stored, mode);
      if (stored.subjectType !== want.subjectType || stored.subjectKey !== want.subjectKey) {
        throw new MemoryError(
          "MEMORY_SCOPE_MISMATCH",
          `thread "${threadId}" is already bound to subject ${describeSubject(stored)}; this run resolved ${describeSubject(want)}. ` +
            `Start a new thread id for a different subject.`,
        );
      }
    }
    this.bindings.set(threadId, binding);
    return binding;
  }

  /** Fail when a thread's stored binding belongs to another org, project, graph, user or principal. */
  private checkOwner(threadId: string, stored: MemoryThreadBinding, mode: string): void {
    const cur = this.baseBinding();
    const diffs: string[] = [];
    if (stored.org !== cur.org) diffs.push("org");
    if (stored.project !== cur.project) diffs.push("project");
    if (stored.graph !== cur.graph) diffs.push("graph");
    if (stored.usr !== cur.user) diffs.push("user");
    const p = this.identity.principalId;
    if (stored.principalId && p && stored.principalId !== p) diffs.push("principal");
    if (diffs.length > 0) {
      throw new MemoryError(
        "MEMORY_SCOPE_MISMATCH",
        `cannot ${mode} thread "${threadId}": it is bound to a different ${diffs.join(", ")} than the current identity`,
      );
    }
  }

  bindingFor(threadId: string | undefined): MemoryBinding {
    return (threadId ? this.bindings.get(threadId) : undefined) ?? this.baseBinding();
  }

  /**
   * Replay identity for one node attempt. A top-level node keeps its id, so
   * records written by older builds still match. A node below another node
   * includes the path. A tool call's path already ends in `tool:<n>`; with the
   * tool name and argument hash, that call is the identity, so two calls do
   * not share an occurrence count and a different call at the same index does
   * not reuse an earlier write.
   */
  static nodeIdForScope(
    path: readonly string[] | undefined,
    nodeId: string,
    tool?: { name: string; argsHash: string },
  ): string {
    const p = path ?? [];
    if (p.length === 0) return nodeId;
    if (p[p.length - 1]?.startsWith("tool:")) return JSON.stringify(tool ? [...p, tool.name, tool.argsHash] : [...p]);
    return replayNodeKey(p, nodeId);
  }

  /** `ctx.memory` for one node attempt (fresh op counter per attempt). */
  memoryFor(threadId: string | undefined, source: MemoryOpSource): ScopedMemory | undefined {
    if (!this.exposeMemory) return undefined;
    return createScopedMemory(this.backend, this.bindingFor(threadId), this.policy, { ...source, threadId });
  }

  /**
   * `ctx.memory` for the node or tool call described by a LangGraph config.
   * `nodeId` is the node being built; a config whose path already ends in
   * `tool:<n>` names that tool call instead. Positional ids from an older
   * build use `legacy` when the call's namespace or node id has changed, and
   * otherwise the node's own id with the config's namespace.
   */
  memoryForConfig(
    lgConfig: { configurable?: Record<string, unknown> } | undefined,
    nodeId: string,
    meta?: { runId?: string | undefined; threadId?: string | undefined },
    legacy?: { checkpointNs?: string | undefined; nodeId: string; cursor?: LegacyWriteCursor | undefined },
    tool?: { name: string; argsHash: string },
  ): ScopedMemory | undefined {
    const conf = (lgConfig?.configurable ?? {}) as Record<string, unknown>;
    const scope = runScopeOf(lgConfig);
    const threadId = typeof conf["thread_id"] === "string" ? conf["thread_id"] : meta?.threadId;
    return this.memoryFor(threadId, {
      checkpointNs: typeof conf["checkpoint_ns"] === "string" ? conf["checkpoint_ns"] : undefined,
      taskId: typeof conf["__pregel_task_id"] === "string" ? conf["__pregel_task_id"] : undefined,
      nodeId: MemoryRuntime.nodeIdForScope(scope?.path, nodeId, tool),
      runId: meta?.runId,
      legacyCheckpointNs: legacy ? legacy.checkpointNs : undefined,
      legacyNodeId: legacy?.nodeId ?? nodeId,
      legacyCursor: legacy?.cursor,
    });
  }

  /** The graph-scoped legacy `ctx.store` view. */
  legacyStore(): LegacyScopedStore {
    this.legacy ??= new LegacyScopedStore(this.backend, tupleForScope(this.baseBinding(), "graph"), this.policy);
    return this.legacy;
  }
}

/** A runtime over a fresh in-process backend (tests, ephemeral legacy store). */
export function createEphemeralMemoryRuntime(
  graph: string,
  opts: { config?: RuntimeMemoryConfig | undefined; exposeMemory?: boolean | undefined; identity?: MemoryIdentity | undefined } = {},
): MemoryRuntime {
  return new MemoryRuntime({
    backend: createInMemoryMemoryBackend(),
    identity: opts.identity ?? LOCAL_MEMORY_IDENTITY,
    graph,
    config: opts.config,
    exposeMemory: opts.exposeMemory ?? false,
  });
}
