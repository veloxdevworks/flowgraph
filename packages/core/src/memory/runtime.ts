/**
 * Per-compiled-graph memory runtime: owns the backend, the host identity, the
 * policy derived from `runtime.memory`, and per-thread scope bindings.
 * Shared (by reference) with embedded subgraphs so they read and write the
 * root graph's scopes.
 */
import { renderDeep } from "@flowgraph/expr";
import { parseDuration } from "../runtime/duration.js";
import { createInMemoryMemoryBackend } from "./in-memory.js";
import { createScopedMemory, defaultMemoryPolicy, type MemoryOpSource, type MemoryPolicy, type ScopedMemory } from "./handle.js";
import { LegacyScopedStore } from "./legacy-store.js";
import { normalizeSubjectKey, tupleForScope, type MemoryBinding } from "./scope.js";
import {
  MemoryError,
  MEMORY_HARD_CAPS,
  type MemoryBackend,
  type MemoryIdentity,
  type MemoryLimits,
} from "./types.js";

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
        const b: MemoryBinding = {
          org: stored.org,
          project: stored.project,
          graph: stored.graph,
          user: stored.usr,
          ...(stored.subjectType ? { subject: { type: stored.subjectType, key: stored.subjectKey } } : {}),
        };
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
    await this.backend.bindThread({
      threadId,
      org: binding.org,
      project: binding.project,
      graph: binding.graph,
      usr: binding.user,
      subjectType: binding.subject?.type ?? "",
      subjectKey: binding.subject?.key ?? "",
    });
    this.bindings.set(threadId, binding);
    return binding;
  }

  bindingFor(threadId: string | undefined): MemoryBinding {
    return (threadId ? this.bindings.get(threadId) : undefined) ?? this.baseBinding();
  }

  /** `ctx.memory` for one node attempt (fresh op counter per attempt). */
  memoryFor(threadId: string | undefined, source: MemoryOpSource): ScopedMemory | undefined {
    if (!this.exposeMemory) return undefined;
    return createScopedMemory(this.backend, this.bindingFor(threadId), this.policy, { ...source, threadId });
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
