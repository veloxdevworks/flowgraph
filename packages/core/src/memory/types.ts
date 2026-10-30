/**
 * Scoped durable memory — shared types.
 *
 * A memory item lives at a scope tuple (org, project, graph, usr, subject_type,
 * subject_key) plus a key. Unused levels are the empty string. Valid shapes:
 *
 *   org      (o, '', '', '', '', '')
 *   project  (o, p,  '', '', '', '')
 *   graph    (o, p,  g,  '', '', '')
 *   user     (o, p,  g,  u,  '', '')
 *   subject  (o, p,  '', '', t,  k)
 */

export const MEMORY_SCOPES = ["org", "project", "graph", "user", "subject"] as const;
export type MemoryScopeName = (typeof MEMORY_SCOPES)[number];

/** Read precedence for `get` without an explicit scope: narrowest first. */
export const MEMORY_READ_PRECEDENCE: readonly MemoryScopeName[] = ["user", "subject", "graph", "project", "org"];

export interface MemoryTuple {
  org: string;
  project: string;
  graph: string;
  usr: string;
  subjectType: string;
  subjectKey: string;
}

/** A stored row as the engine sees it (value already parsed). */
export interface MemoryRow extends MemoryTuple {
  id: number;
  key: string;
  value: unknown;
  attrs: Record<string, string | number | boolean | null>;
  bytes: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  writtenBy: string | null;
  writtenByRun: string | null;
}

/** What callers get back from reads. */
export interface MemoryRecord {
  key: string;
  value: unknown;
  attrs: Record<string, string | number | boolean | null>;
  scope: MemoryScopeName;
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export type MemoryErrorCode =
  | "MEMORY_SUBJECT_UNRESOLVED"
  | "MEMORY_VALUE_TOO_LARGE"
  | "MEMORY_SCOPE_FULL"
  | "MEMORY_VERSION_CONFLICT"
  | "MEMORY_SCOPE_UNAVAILABLE"
  | "MEMORY_SCOPE_FORBIDDEN"
  | "MEMORY_SCOPE_INVALID"
  | "MEMORY_SECRET_DETECTED"
  | "MEMORY_KEY_INVALID"
  | "MEMORY_ATTRS_INVALID"
  | "MEMORY_TYPE_MISMATCH"
  | "MEMORY_BACKEND_UNAVAILABLE"
  | "MEMORY_BACKEND_UNKNOWN"
  | "MEMORY_STORE_AND_MEMORY"
  | "MEMORY_NOT_CONFIGURED";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: MemoryErrorCode, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "MemoryError";
    this.code = code;
    this.details = details;
  }
}

export function isMemoryError(err: unknown, code?: MemoryErrorCode): err is MemoryError {
  return err instanceof MemoryError && (code === undefined || err.code === code);
}

/** Effective limits for one write. All sizes in bytes of the JSON encoding. */
export interface MemoryLimits {
  keyChars: number;
  itemBytes: number;
  itemsPerScope: number;
  bytesPerScope: number;
  /** Behaviour when a scope is full. org/project scopes always reject. */
  onFull: "evict-oldest" | "reject";
  /** Distinct subjects per (org, project, subject_type); oldest subject evicted beyond it. */
  subjectsPerType: number;
  attrKeys: number;
  attrChars: number;
}

export const MEMORY_DEFAULT_LIMITS: MemoryLimits = {
  keyChars: 256,
  itemBytes: 8 * 1024,
  itemsPerScope: 500,
  bytesPerScope: 2 * 1024 * 1024,
  onFull: "evict-oldest",
  subjectsPerType: 5_000,
  attrKeys: 8,
  attrChars: 128,
};

export const MEMORY_SUBJECT_DEFAULT_LIMITS: Pick<MemoryLimits, "itemsPerScope" | "bytesPerScope"> = {
  itemsPerScope: 100,
  bytesPerScope: 256 * 1024,
};

/** Hard caps — configuration above these is a validation error. */
export const MEMORY_HARD_CAPS = {
  itemBytes: 64 * 1024,
  itemsPerScope: 10_000,
  bytesPerScope: 50 * 1024 * 1024,
  subjectsPerType: 50_000,
} as const;

export const MEMORY_SUBJECT_DEFAULT_TTL_MS = 180 * 86_400_000;
export const MEMORY_APPEND_DEFAULT_MAX = 100;
export const MEMORY_APPEND_MAX_CAP = 1_000;

export type MemoryWriteKind = "put" | "patch" | "increment" | "append" | "delete";

export interface MemoryWriteOp {
  kind: MemoryWriteKind;
  tuple: MemoryTuple;
  key: string;
  /** put: the value. patch: an object shallow-merged into the stored object. append: the item. */
  value?: unknown;
  attrs?: Record<string, unknown> | undefined;
  /** increment: field to bump inside an object value ("" = the value itself is the number). */
  field?: string | undefined;
  by?: number | undefined;
  /** append: max list length (oldest dropped). */
  max?: number | undefined;
  /** CAS: expected current version; 0 means "must not exist". */
  ifVersion?: number | undefined;
  /** Explicit per-item TTL (ms). Subject scope uses the subject TTL instead. */
  ttlMs?: number | undefined;
  /** Sliding TTL for subject scope (ms); refreshed on every write to the subject. */
  subjectTtlMs?: number | undefined;
  /** Replay-safe write id; a repeated id is a no-op returning the first result. */
  opId?: string | undefined;
  limits: MemoryLimits;
  /** Skip secret detection (legacy ctx.store adapter only). */
  allowSecrets?: boolean | undefined;
  writtenBy?: string | undefined;
  writtenByRun?: string | undefined;
  now?: number | undefined;
}

export interface MemoryWriteResult {
  version: number;
  value: unknown;
  /** True when opId had already been applied and nothing changed. */
  deduped: boolean;
  /** Items evicted to make room. */
  evicted: number;
}

export interface MemoryListOptions {
  prefix?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  limit?: number | undefined;
  now?: number | undefined;
}

/** Binding of a thread to its scope tuple, persisted in fg_threads. */
export interface MemoryThreadBinding {
  threadId: string;
  org: string;
  project: string;
  graph: string;
  usr: string;
  subjectType: string;
  subjectKey: string;
  principalId?: string | null | undefined;
  createdAt?: number | undefined;
}

/**
 * Storage backend for scoped memory. Implementations: in-memory (tests),
 * sqlite (`@flowgraph/checkpoint-sqlite`), postgres (phase 4).
 */
export interface MemoryBackend {
  readonly kind: string;
  /** True when items survive process restart. */
  readonly durable: boolean;
  get(tuple: MemoryTuple, key: string, now?: number): Promise<MemoryRow | null>;
  list(tuple: MemoryTuple, opts?: MemoryListOptions): Promise<MemoryRow[]>;
  write(op: MemoryWriteOp): Promise<MemoryWriteResult>;
  /** Insert or replace the thread's binding. */
  bindThread(binding: MemoryThreadBinding): Promise<void>;
  getThread(threadId: string): Promise<MemoryThreadBinding | null>;
  /** Delete expired rows and old op ids; returns rows removed. */
  sweep(now?: number): Promise<number>;
  close?(): void | Promise<void>;
}

/** Who/where a host runs: resolved by the CLI (or server, later). */
export interface MemoryIdentity {
  org: string;
  project: string;
  /** Absent when no user can be determined; user-scope writes then fail. */
  user?: string | undefined;
}
