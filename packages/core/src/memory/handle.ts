/**
 * `ctx.memory` — a scoped memory handle pre-bound to the run's
 * (org, project, graph, user, subject). There is no way to name another
 * graph, user or subject through it.
 */
import { createHash } from "node:crypto";
import { parseDuration } from "../runtime/duration.js";
import { availableScopes, isMemoryScopeName, tupleForScope, type MemoryBinding } from "./scope.js";
import {
  MemoryError,
  MEMORY_READ_PRECEDENCE,
  MEMORY_SUBJECT_DEFAULT_LIMITS,
  MEMORY_SUBJECT_DEFAULT_TTL_MS,
  MEMORY_DEFAULT_LIMITS,
  type MemoryBackend,
  type MemoryLimits,
  type MemoryRecord,
  type MemoryRow,
  type MemoryScopeName,
  type MemoryWriteKind,
  type MemoryWriteOp,
} from "./types.js";

export interface MemoryWriteOptions {
  attrs?: Record<string, unknown> | undefined;
  /** Per-item TTL ("7d", "12h" or ms). Ignored for subject scope (subject TTL applies). */
  ttl?: string | number | undefined;
  /** CAS: expected current version; 0 = create only. */
  ifVersion?: number | undefined;
}

export interface MemoryReadOptions {
  /** Scopes to consult, in order. Default: user > subject > graph > project > org. */
  scopes?: MemoryScopeName[] | undefined;
}

export interface MemorySearchOptions extends MemoryReadOptions {
  prefix?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  /** Default 20, max 200. */
  limit?: number | undefined;
  /** Collapse the same key across scopes, narrowest wins (default true). */
  dedupe?: boolean | undefined;
}

export interface MemorySimilarOptions {
  /** Subject type; defaults to the graph's declared subject type and must equal it. */
  type?: string | undefined;
  /** Exact attr equality. */
  match?: Record<string, unknown> | undefined;
  /** Extra exact attr filters (merged with match). */
  where?: Record<string, unknown> | undefined;
  prefix?: string | undefined;
  /** Max subjects (default 5, max 50). */
  limit?: number | undefined;
  /** Items per subject (default 2, max 10). */
  perSubject?: number | undefined;
}

export interface MemorySimilarSubject {
  subject: { type: string; key: string };
  /** Newest first; scope is "subject". */
  items: MemoryRecord[];
}

export interface MemoryWriteOutcome {
  version: number;
  value: unknown;
  /** True when this write was a replay of an already-applied op. */
  deduped: boolean;
}

export interface MemoryScopeInfo {
  org: string;
  project: string;
  graph: string;
  user?: string | undefined;
  subject?: { type: string; key: string } | undefined;
}

export interface ScopedMemory {
  readonly scope: MemoryScopeInfo;
  readonly durable: boolean;
  get(key: string, opts?: MemoryReadOptions): Promise<MemoryRecord | null>;
  search(opts?: MemorySearchOptions): Promise<MemoryRecord[]>;
  /**
   * Other subjects of this graph's subject type in the same org/project whose
   * items match `match`/`where` attrs, most recently active first. The run's own
   * subject is excluded; user and graph scopes are never read.
   */
  similarSubjects(opts?: MemorySimilarOptions): Promise<MemorySimilarSubject[]>;
  put(scope: MemoryScopeName, key: string, value: unknown, opts?: MemoryWriteOptions): Promise<MemoryWriteOutcome>;
  /** Shallow-merge `value` into the stored object (atomic). */
  patch(scope: MemoryScopeName, key: string, value: Record<string, unknown>, opts?: MemoryWriteOptions): Promise<MemoryWriteOutcome>;
  /** Atomically add `by` (default 1) to `field` of the stored object; field "" bumps a bare number. */
  increment(scope: MemoryScopeName, key: string, field?: string, by?: number, opts?: MemoryWriteOptions): Promise<MemoryWriteOutcome>;
  /** Atomically append to a bounded list (default max 100; oldest dropped). */
  append(scope: MemoryScopeName, key: string, item: unknown, opts?: MemoryWriteOptions & { max?: number }): Promise<MemoryWriteOutcome>;
  delete(scope: MemoryScopeName, key: string, opts?: Pick<MemoryWriteOptions, "ifVersion">): Promise<MemoryWriteOutcome>;
  /**
   * Read-modify-write with optimistic concurrency: `fn` receives the current
   * value (undefined when absent) and returns the next one; retried on
   * MEMORY_VERSION_CONFLICT up to `retries` times (default 5).
   */
  update(
    scope: MemoryScopeName,
    key: string,
    fn: (current: unknown, version: number) => unknown | Promise<unknown>,
    opts?: Omit<MemoryWriteOptions, "ifVersion"> & { retries?: number },
  ): Promise<MemoryWriteOutcome>;
}

export interface MemoryPolicy {
  /** Limits for org/project/graph/user scopes. */
  limits: MemoryLimits;
  /** Limits for subject scope. */
  subjectLimits: MemoryLimits;
  subjectTtlMs: number;
  /** Declared `runtime.memory.subject.type` (similarSubjects is limited to it). */
  subjectType?: string | undefined;
}

export function defaultMemoryPolicy(): MemoryPolicy {
  return {
    limits: { ...MEMORY_DEFAULT_LIMITS },
    subjectLimits: { ...MEMORY_DEFAULT_LIMITS, ...MEMORY_SUBJECT_DEFAULT_LIMITS },
    subjectTtlMs: MEMORY_SUBJECT_DEFAULT_TTL_MS,
  };
}

/** Where a write comes from; used to derive replay-safe op ids. */
export interface MemoryOpSource {
  threadId?: string | undefined;
  checkpointNs?: string | undefined;
  taskId?: string | undefined;
  nodeId?: string | undefined;
  runId?: string | undefined;
}

export function rowToRecord(row: MemoryRow, scope: MemoryScopeName): MemoryRecord {
  return {
    key: row.key,
    value: row.value,
    attrs: row.attrs,
    scope,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

function toTtlMs(ttl: string | number | undefined): number | undefined {
  if (ttl === undefined) return undefined;
  return typeof ttl === "number" ? ttl : parseDuration(ttl);
}

function checkScope(scope: unknown): MemoryScopeName {
  if (!isMemoryScopeName(scope)) {
    throw new MemoryError("MEMORY_SCOPE_INVALID", `scope must be one of org, project, graph, user, subject (got ${JSON.stringify(scope)})`);
  }
  return scope;
}

export function createScopedMemory(
  backend: MemoryBackend,
  binding: MemoryBinding,
  policy: MemoryPolicy,
  source: MemoryOpSource = {},
): ScopedMemory {
  let opIndex = 0;
  const canDedupe = !!(source.threadId && source.taskId);
  const nextOpId = (): string | undefined => {
    const n = opIndex++;
    if (!canDedupe) return undefined;
    return createHash("sha256")
      .update([source.threadId, source.checkpointNs ?? "", source.taskId, source.nodeId ?? "", String(n)].join("\u0000"))
      .digest("hex");
  };

  const readScopes = (scopes: MemoryScopeName[] | undefined) =>
    availableScopes(binding, (scopes ?? [...MEMORY_READ_PRECEDENCE]).map(checkScope));

  const write = async (
    kind: MemoryWriteKind,
    scope: MemoryScopeName,
    key: string,
    extra: Partial<MemoryWriteOp>,
    opts: MemoryWriteOptions | undefined,
    opId = nextOpId(),
  ): Promise<MemoryWriteOutcome> => {
    const s = checkScope(scope);
    const tuple = tupleForScope(binding, s);
    const op: MemoryWriteOp = {
      kind,
      tuple,
      key,
      ...extra,
      attrs: opts?.attrs,
      ifVersion: opts?.ifVersion,
      ttlMs: toTtlMs(opts?.ttl),
      subjectTtlMs: policy.subjectTtlMs,
      opId,
      limits: s === "subject" ? policy.subjectLimits : policy.limits,
      writtenBy: binding.user || undefined,
      writtenByRun: source.runId,
    };
    const r = await backend.write(op);
    return { version: r.version, value: r.value, deduped: r.deduped };
  };

  const scopeInfo: MemoryScopeInfo = Object.freeze({
    org: binding.org,
    project: binding.project,
    graph: binding.graph,
    ...(binding.user ? { user: binding.user } : {}),
    ...(binding.subject ? { subject: { ...binding.subject } } : {}),
  });

  return {
    scope: scopeInfo,
    durable: backend.durable,
    async get(key, opts) {
      for (const s of readScopes(opts?.scopes)) {
        const row = await backend.get(tupleForScope(binding, s), key);
        if (row) return rowToRecord(row, s);
      }
      return null;
    },
    async search(opts = {}) {
      const limit = Math.max(0, Math.min(opts.limit ?? 20, 200));
      const dedupe = opts.dedupe !== false;
      const seen = new Set<string>();
      const out: MemoryRecord[] = [];
      // Narrowest scope first, so with dedupe the narrowest copy of a key wins.
      const scopes = readScopes(opts.scopes).sort(
        (a, b) => MEMORY_READ_PRECEDENCE.indexOf(a) - MEMORY_READ_PRECEDENCE.indexOf(b),
      );
      for (const s of scopes) {
        if (out.length >= limit) break;
        const rows = await backend.list(tupleForScope(binding, s), {
          prefix: opts.prefix,
          attrs: opts.attrs,
          limit: dedupe ? limit : limit - out.length,
        });
        for (const r of rows) {
          if (out.length >= limit) break;
          if (dedupe) {
            if (seen.has(r.key)) continue;
            seen.add(r.key);
          }
          out.push(rowToRecord(r, s));
        }
      }
      return out;
    },
    async similarSubjects(opts = {}) {
      const declared = policy.subjectType ?? binding.subject?.type;
      if (!declared) {
        throw new MemoryError(
          "MEMORY_SUBJECT_UNDECLARED",
          "similarSubjects needs runtime.memory.subject (the subject type to search)",
        );
      }
      const type = opts.type ?? declared;
      if (type !== declared) {
        throw new MemoryError(
          "MEMORY_SUBJECT_TYPE_MISMATCH",
          `similarSubjects type "${type}" but this graph binds "${declared}"`,
        );
      }
      const groups = await backend.similarSubjects({
        org: binding.org,
        project: binding.project,
        subjectType: type,
        excludeSubjectKey: binding.subject?.key ?? "",
        attrs: { ...(opts.match ?? {}), ...(opts.where ?? {}) },
        prefix: opts.prefix,
        limit: opts.limit ?? 5,
        perSubject: opts.perSubject ?? 2,
      });
      return groups.map((g) => ({
        subject: { type, key: g.subjectKey },
        items: g.items.map((r) => rowToRecord(r, "subject")),
      }));
    },
    put(scope, key, value, opts) {
      return write("put", scope, key, { value }, opts);
    },
    patch(scope, key, value, opts) {
      return write("patch", scope, key, { value }, opts);
    },
    increment(scope, key, field = "count", by = 1, opts) {
      return write("increment", scope, key, { field, by }, opts);
    },
    append(scope, key, item, opts) {
      return write("append", scope, key, { value: item, max: opts?.max }, opts);
    },
    delete(scope, key, opts) {
      return write("delete", scope, key, {}, opts);
    },
    async update(scope, key, fn, opts) {
      const s = checkScope(scope);
      const tuple = tupleForScope(binding, s);
      const retries = Math.max(0, opts?.retries ?? 5);
      const opId = nextOpId();
      for (let attempt = 0; ; attempt++) {
        const row = await backend.get(tuple, key);
        const version = row?.version ?? 0;
        const next = await fn(row ? row.value : undefined, version);
        try {
          return await write("put", s, key, { value: next }, { ...opts, ifVersion: version }, opId);
        } catch (err) {
          if (err instanceof MemoryError && err.code === "MEMORY_VERSION_CONFLICT" && attempt < retries) {
            await new Promise((r) => setTimeout(r, Math.random() * Math.min(200, 4 * 2 ** attempt)));
            continue;
          }
          throw err;
        }
      }
    },
  };
}
