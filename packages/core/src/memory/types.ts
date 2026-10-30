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
  | "MEMORY_SCOPE_MISMATCH"
  | "MEMORY_VALUE_TOO_LARGE"
  | "MEMORY_SCOPE_FULL"
  | "MEMORY_VERSION_CONFLICT"
  | "MEMORY_SCOPE_UNAVAILABLE"
  | "MEMORY_SCOPE_FORBIDDEN"
  | "MEMORY_SCOPE_INVALID"
  | "MEMORY_SECRET_DETECTED"
  | "MEMORY_KEY_INVALID"
  | "MEMORY_NUL_CHARACTER"
  | "MEMORY_LONE_SURROGATE"
  | "MEMORY_ATTRS_INVALID"
  | "MEMORY_TYPE_MISMATCH"
  | "MEMORY_BACKEND_UNAVAILABLE"
  | "MEMORY_BACKEND_UNKNOWN"
  | "MEMORY_STORE_AND_MEMORY"
  | "MEMORY_NOT_CONFIGURED"
  | "MEMORY_SUBJECT_TYPE_MISMATCH"
  | "MEMORY_SUBJECT_UNDECLARED"
  | "MEMORY_WRITE_LIMIT"
  | "MEMORY_IDEMPOTENCY_CONFLICT";

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
  /**
   * Replay id. The same id and fingerprint return the first result and write
   * nothing. A different fingerprint under that id is applied once and stored
   * as `opId~fingerprint`, so alternating payloads each apply once.
   *
   * `ctx.memory` derives the id from the write's fingerprint and how many
   * times that write has already run in the attempt, so a retry can reorder,
   * add or drop writes without applying an earlier one again.
   */
  opId?: string | undefined;
  /**
   * Identity of the write for op-id dedupe. Defaults to a hash of the tuple,
   * key, kind and arguments. `update()` passes tuple + key so a CAS loop whose
   * computed value changes on retry still dedupes. An idempotency key hashes
   * the key together with the kind, scope tuple and memory key (not the
   * payload). A different payload for that same operation does not write again.
   */
  fingerprint?: string | undefined;
  /**
   * When set, a stored row for `opId` whose fingerprint differs is
   * `MEMORY_IDEMPOTENCY_CONFLICT` instead of a second write. Set for
   * idempotency keys.
   */
  rejectFingerprintMismatch?: boolean | undefined;
  /**
   * Which older positional record with this fingerprint to adopt (0 is the
   * first). Set with {@link legacyOpIdAt}. Absent means positional records
   * are not consulted. A null fingerprint never matches.
   */
  legacyMatchIndex?: number | undefined;
  /** Positional op id an older build stored at `index` for this node attempt. */
  legacyOpIdAt?: ((index: number) => string) | undefined;
  /**
   * Recorded once a scan finds no positional rows for this attempt, so later
   * writes skip the scan. Not a write of its own.
   */
  legacySentinelId?: string | undefined;
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
  /**
   * This attempt has no positional op rows to adopt. The handle stops asking
   * for that scan.
   */
  legacyAbsent?: boolean | undefined;
}

export interface MemoryListOptions {
  prefix?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  limit?: number | undefined;
  now?: number | undefined;
}

/** Cross-subject search: other subjects of one type in one project. */
export interface MemorySimilarQuery {
  org: string;
  project: string;
  subjectType: string;
  /** The run's own subject key, excluded from results ("" = exclude nothing). */
  excludeSubjectKey?: string | undefined;
  /** Exact attr equality (match + where). */
  attrs?: Record<string, unknown> | undefined;
  /** Key prefix filter. */
  prefix?: string | undefined;
  /** Max subjects (newest activity first). */
  limit: number;
  /** Max items per subject (newest first). */
  perSubject: number;
  now?: number | undefined;
}

export interface MemorySimilarGroup {
  subjectKey: string;
  /** Newest matching item first. */
  items: MemoryRow[];
}

export const MEMORY_SIMILAR_MAX_SUBJECTS = 50;
export const MEMORY_SIMILAR_MAX_PER_SUBJECT = 10;

/** Agent recall budget (tokens are estimated as UTF-8 bytes / 4). */
export const MEMORY_RECALL_DEFAULT_TOKENS = 1_000;
export const MEMORY_RECALL_MAX_TOKENS = 4_000;
export const MEMORY_RECALL_DEFAULT_ITEMS = 20;
export const MEMORY_RECALL_ITEM_TOKENS = 400;
export const MEMORY_AGENT_WRITES_DEFAULT = 5;

export interface MemorySweepOptions {
  /**
   * Keep op-id records (replay dedupe) this long. Default 30 days; a resume
   * after the window may re-apply a write.
   */
  opsRetentionMs?: number | undefined;
}

/** Binding of a thread to its scope tuple, persisted with the memory tables. */
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
 * sqlite (`@flowgraph/checkpoint-sqlite`), postgres (`@flowgraph/checkpoint-postgres`).
 */
export interface MemoryBackend {
  readonly kind: string;
  /** True when items survive process restart. */
  readonly durable: boolean;
  get(tuple: MemoryTuple, key: string, now?: number): Promise<MemoryRow | null>;
  list(tuple: MemoryTuple, opts?: MemoryListOptions): Promise<MemoryRow[]>;
  write(op: MemoryWriteOp): Promise<MemoryWriteResult>;
  /**
   * Items of other subjects of the same type in the same org/project, grouped by
   * subject (most recently active subject first). Never reads user or graph scope.
   */
  similarSubjects(q: MemorySimilarQuery): Promise<MemorySimilarGroup[]>;
  /**
   * Bind a thread if it has no binding yet. Never overwrites an existing
   * binding; callers re-read with {@link getThread} to detect a conflict.
   */
  bindThread(binding: MemoryThreadBinding): Promise<void>;
  getThread(threadId: string): Promise<MemoryThreadBinding | null>;
  /** Delete expired rows and old op ids; returns item rows removed. */
  sweep(now?: number, opts?: MemorySweepOptions): Promise<number>;
  close?(): void | Promise<void>;
}

/** Who/where a host runs: resolved by the CLI (or server, later). */
export interface MemoryIdentity {
  org: string;
  project: string;
  /** Absent when no user can be determined; user-scope writes then fail. */
  user?: string | undefined;
  /** Authenticated principal (server hosts); stored with each thread binding. */
  principalId?: string | undefined;
}
