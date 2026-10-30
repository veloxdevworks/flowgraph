/**
 * Backend-independent write semantics for scoped memory.
 *
 * Backends implement the small synchronous {@link MemoryTable} interface and
 * run {@link applyMemoryWrite} inside one transaction, so every backend gets the
 * same atomic increment/append/merge, CAS, op-id dedupe, limits and TTL rules.
 */
import { createHash } from "node:crypto";
import { DEFAULT_REDACT_PATTERNS } from "../secrets.js";
import { scopeOfTuple, tupleKey } from "./scope.js";
import {
  MemoryError,
  MEMORY_APPEND_DEFAULT_MAX,
  MEMORY_APPEND_MAX_CAP,
  MEMORY_SIMILAR_MAX_PER_SUBJECT,
  MEMORY_SIMILAR_MAX_SUBJECTS,
  MEMORY_SUBJECT_DEFAULT_TTL_MS,
  type MemoryBackend,
  type MemoryListOptions,
  type MemoryRow,
  type MemorySimilarGroup,
  type MemorySimilarQuery,
  type MemoryThreadBinding,
  type MemoryTuple,
  type MemoryWriteOp,
  type MemoryWriteResult,
} from "./types.js";

/** Op ids older than this are swept. Long enough to cover any resume window. */
export const MEMORY_OP_RETENTION_MS = 30 * 86_400_000;

export interface MemoryTable {
  find(t: MemoryTuple, key: string): MemoryRow | undefined;
  insert(row: Omit<MemoryRow, "id">): void;
  update(row: MemoryRow): void;
  remove(id: number): void;
  /** Delete expired rows in exactly this tuple. */
  removeExpired(t: MemoryTuple, now: number): void;
  usage(t: MemoryTuple, now: number): { items: number; bytes: number };
  /** Least recently updated live rows in this tuple, oldest first. */
  oldest(t: MemoryTuple, limit: number, excludeKey: string, now: number): MemoryRow[];
  /** Live rows in this tuple, most recently updated first, filtered by key prefix. */
  list(t: MemoryTuple, prefix: string | undefined, now: number, limit?: number): MemoryRow[];
  /**
   * Live rows of other subjects matching {@link MemorySimilarQuery}: at most
   * `limit` subjects (most recent matching item first, ties by subject key) and
   * `perSubject` rows each (newest first). Rows are returned grouped in that order.
   */
  similar(q: MemorySimilarQuery & { now: number }): MemoryRow[];
  /** Set expires_at on every row of a subject (sliding TTL). */
  touchSubject(org: string, project: string, type: string, key: string, expiresAt: number): void;
  /** Distinct live subject keys of a type in a project, least recently written first. */
  subjectsByAge(org: string, project: string, type: string, now: number): string[];
  removeSubject(org: string, project: string, type: string, key: string): number;
  opGet(opId: string): { version: number; value: unknown; fingerprint: string | null } | undefined;
  /** Insert or replace the op record. */
  opPut(opId: string, result: { version: number; value: unknown }, now: number, fingerprint: string | null): void;
  /** Insert the binding unless the thread already has one (never overwrites). */
  putThread(b: MemoryThreadBinding): void;
  getThread(threadId: string): MemoryThreadBinding | undefined;
  sweep(now: number, opsBefore: number): number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isExpired(row: { expiresAt: number | null }, now: number): boolean {
  return row.expiresAt !== null && row.expiresAt <= now;
}

export function validateMemoryKey(key: unknown, maxChars: number): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new MemoryError("MEMORY_KEY_INVALID", "memory key must be a non-empty string");
  }
  if (key.length > maxChars) {
    throw new MemoryError("MEMORY_KEY_INVALID", `memory key is longer than ${maxChars} characters`);
  }
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(key)) {
    throw new MemoryError(
      "MEMORY_KEY_INVALID",
      `memory key ${JSON.stringify(key)} contains control, format (zero-width/bidi) or line-separator characters`,
    );
  }
  return key;
}

function validateAttrs(
  attrs: Record<string, unknown>,
  maxKeys: number,
  maxChars: number,
): Record<string, string | number | boolean | null> {
  if (!isPlainObject(attrs)) throw new MemoryError("MEMORY_ATTRS_INVALID", "attrs must be an object");
  const entries = Object.entries(attrs);
  if (entries.length > maxKeys) {
    throw new MemoryError("MEMORY_ATTRS_INVALID", `attrs may have at most ${maxKeys} keys`);
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of entries) {
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") {
      if (v.length > maxChars) throw new MemoryError("MEMORY_ATTRS_INVALID", `attr "${k}" is longer than ${maxChars} characters`);
      out[k] = v;
    } else throw new MemoryError("MEMORY_ATTRS_INVALID", `attr "${k}" must be a string, number, boolean or null`);
  }
  return out;
}

/** Well-known credential shapes, on top of the event redaction patterns. */
const MEMORY_SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
];

export function containsSecret(text: string): boolean {
  return (
    MEMORY_SECRET_PATTERNS.some((re) => re.test(text)) ||
    DEFAULT_REDACT_PATTERNS.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(text))
  );
}

function encode(value: unknown): { json: string; bytes: number } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new MemoryError("MEMORY_TYPE_MISMATCH", `value is not JSON-serializable: ${(err as Error).message}`);
  }
  if (json === undefined) throw new MemoryError("MEMORY_TYPE_MISMATCH", "value is not JSON-serializable");
  return { json, bytes: Buffer.byteLength(json, "utf8") };
}

function nextValue(op: MemoryWriteOp, current: unknown, exists: boolean): unknown {
  switch (op.kind) {
    case "put":
      return op.value === undefined ? null : op.value;
    case "patch": {
      const base = exists ? current : {};
      if (!isPlainObject(base)) throw new MemoryError("MEMORY_TYPE_MISMATCH", `patch: stored value at "${op.key}" is not an object`);
      if (!isPlainObject(op.value)) throw new MemoryError("MEMORY_TYPE_MISMATCH", "patch: value must be an object");
      return { ...base, ...op.value };
    }
    case "increment": {
      const by = op.by ?? 1;
      if (typeof by !== "number" || !Number.isFinite(by)) throw new MemoryError("MEMORY_TYPE_MISMATCH", "increment: by must be a finite number");
      const field = op.field ?? "";
      if (field === "") {
        const cur = exists ? current : 0;
        if (typeof cur !== "number") throw new MemoryError("MEMORY_TYPE_MISMATCH", `increment: stored value at "${op.key}" is not a number`);
        return cur + by;
      }
      const base = exists ? current : {};
      if (!isPlainObject(base)) throw new MemoryError("MEMORY_TYPE_MISMATCH", `increment: stored value at "${op.key}" is not an object`);
      const cur = base[field] ?? 0;
      if (typeof cur !== "number") throw new MemoryError("MEMORY_TYPE_MISMATCH", `increment: field "${field}" is not a number`);
      return { ...base, [field]: cur + by };
    }
    case "append": {
      const base = exists ? current : [];
      if (!Array.isArray(base)) throw new MemoryError("MEMORY_TYPE_MISMATCH", `append: stored value at "${op.key}" is not a list`);
      const max = Math.max(1, Math.min(op.max ?? MEMORY_APPEND_DEFAULT_MAX, MEMORY_APPEND_MAX_CAP));
      const next = [...base, op.value === undefined ? null : op.value];
      return next.length > max ? next.slice(next.length - max) : next;
    }
    default:
      throw new MemoryError("MEMORY_TYPE_MISMATCH", `unknown write kind "${String(op.kind)}"`);
  }
}

/** JSON with object keys sorted recursively, so key order never changes a hash. */
function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object" && !(x instanceof Date)) {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** Stable identity of a write for op-id dedupe: tuple, key, kind and arguments (canonical JSON). */
export function writeFingerprint(op: Pick<MemoryWriteOp, "kind" | "tuple" | "key" | "value" | "attrs" | "field" | "by" | "max" | "ifVersion" | "ttlMs">): string {
  let args: string;
  try {
    args = canonicalJson([op.value ?? null, op.attrs ?? null, op.field ?? null, op.by ?? null, op.max ?? null, op.ifVersion ?? null, op.ttlMs ?? null]);
  } catch {
    args = String(Math.random()); // unserializable: never treat as a replay
  }
  return createHash("sha256")
    .update([tupleKey(op.tuple), op.key, op.kind, args].join("\u0000"))
    .digest("hex");
}

/**
 * Apply one write. MUST be called inside a single transaction by the backend
 * (it reads then writes). Throws {@link MemoryError}; the caller's transaction
 * rolls back on throw.
 */
export function applyMemoryWrite(table: MemoryTable, op: MemoryWriteOp): MemoryWriteResult {
  const now = op.now ?? Date.now();
  const t = op.tuple;
  const scope = scopeOfTuple(t);
  const limits = op.limits;
  validateMemoryKey(op.key, limits.keyChars);

  const fingerprint = op.opId ? (op.fingerprint ?? writeFingerprint(op)) : null;
  // Op row this write is recorded under. Only the same write (same tuple, key,
  // kind and arguments) is a replay. A retry that made a different write at this
  // position is applied, never dropped, and recorded under opId~fingerprint so
  // the first write's record is kept and alternating retries (A, B, A, B) each
  // apply once.
  let opKey = op.opId;
  if (op.opId) {
    const prior = table.opGet(op.opId);
    if (prior && prior.fingerprint === fingerprint) {
      return { version: prior.version, value: prior.value, deduped: true, evicted: 0 };
    }
    if (prior) {
      opKey = `${op.opId}~${fingerprint}`;
      const alt = table.opGet(opKey);
      if (alt && alt.fingerprint === fingerprint) {
        return { version: alt.version, value: alt.value, deduped: true, evicted: 0 };
      }
    }
  }

  table.removeExpired(t, now);
  let existing = table.find(t, op.key);
  if (existing && isExpired(existing, now)) {
    table.remove(existing.id);
    existing = undefined;
  }

  if (op.ifVersion !== undefined) {
    const cur = existing?.version ?? 0;
    if (cur !== op.ifVersion) {
      throw new MemoryError(
        "MEMORY_VERSION_CONFLICT",
        `"${op.key}" is at version ${cur}, expected ${op.ifVersion}`,
        { key: op.key, version: cur, expected: op.ifVersion },
      );
    }
  }

  if (op.kind === "delete") {
    if (existing) table.remove(existing.id);
    const result = { version: 0, value: null };
    if (opKey) table.opPut(opKey, result, now, fingerprint);
    return { ...result, deduped: false, evicted: 0 };
  }

  const value = nextValue(op, existing?.value, existing !== undefined);
  const { json, bytes } = encode(value);
  if (bytes > limits.itemBytes) {
    throw new MemoryError(
      "MEMORY_VALUE_TOO_LARGE",
      `"${op.key}" would be ${bytes} bytes; the limit is ${limits.itemBytes}`,
      { key: op.key, bytes, limit: limits.itemBytes },
    );
  }
  const attrs =
    op.attrs !== undefined ? validateAttrs(op.attrs, limits.attrKeys, limits.attrChars) : (existing?.attrs ?? {});

  if (!op.allowSecrets && containsSecret(`${op.key}\n${json}\n${JSON.stringify(attrs)}`)) {
    throw new MemoryError(
      "MEMORY_SECRET_DETECTED",
      `refusing to store "${op.key}": the value looks like it contains a credential`,
      { key: op.key },
    );
  }

  let expiresAt: number | null;
  if (scope === "subject") expiresAt = now + (op.subjectTtlMs ?? MEMORY_SUBJECT_DEFAULT_TTL_MS);
  else if (op.ttlMs !== undefined) expiresAt = now + op.ttlMs;
  else if (op.kind === "put") expiresAt = null;
  else expiresAt = existing?.expiresAt ?? null;

  // ── scope capacity ────────────────────────────────────────────────────────
  let evicted = 0;
  const usage = table.usage(t, now);
  const items = usage.items + (existing ? 0 : 1);
  let total = usage.bytes - (existing?.bytes ?? 0) + bytes;
  if (items > limits.itemsPerScope || total > limits.bytesPerScope) {
    const mustReject = limits.onFull === "reject" || scope === "org" || scope === "project";
    if (mustReject) {
      throw new MemoryError(
        "MEMORY_SCOPE_FULL",
        `${scope} scope is full (${usage.items} items, ${usage.bytes} bytes; limits ${limits.itemsPerScope} items, ${limits.bytesPerScope} bytes)`,
        { scope, items: usage.items, bytes: usage.bytes },
      );
    }
    let liveItems = items;
    const victims = table.oldest(t, Math.max(1, liveItems - limits.itemsPerScope + 16), op.key, now);
    for (const v of victims) {
      if (liveItems <= limits.itemsPerScope && total <= limits.bytesPerScope) break;
      table.remove(v.id);
      liveItems -= 1;
      total -= v.bytes;
      evicted += 1;
    }
    while (total > limits.bytesPerScope) {
      const more = table.oldest(t, 16, op.key, now);
      if (more.length === 0) break;
      for (const v of more) {
        if (total <= limits.bytesPerScope) break;
        table.remove(v.id);
        total -= v.bytes;
        evicted += 1;
      }
    }
  }

  // ── subjects per type cap (oldest subject evicted) ───────────────────────
  if (scope === "subject" && usage.items === 0) {
    const subjects = table.subjectsByAge(t.org, t.project, t.subjectType, now).filter((k) => k !== t.subjectKey);
    let excess = subjects.length + 1 - limits.subjectsPerType;
    for (const k of subjects) {
      if (excess <= 0) break;
      evicted += table.removeSubject(t.org, t.project, t.subjectType, k);
      excess -= 1;
    }
  }

  const version = (existing?.version ?? 0) + 1;
  if (existing) {
    table.update({
      ...existing,
      value,
      attrs,
      bytes,
      version,
      updatedAt: now,
      expiresAt,
      writtenBy: op.writtenBy ?? existing.writtenBy,
      writtenByRun: op.writtenByRun ?? existing.writtenByRun,
    });
  } else {
    table.insert({
      ...t,
      key: op.key,
      value,
      attrs,
      bytes,
      version,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      writtenBy: op.writtenBy ?? null,
      writtenByRun: op.writtenByRun ?? null,
    });
  }
  if (scope === "subject" && expiresAt !== null) {
    table.touchSubject(t.org, t.project, t.subjectType, t.subjectKey, expiresAt);
  }

  const result = { version, value };
  if (opKey) table.opPut(opKey, result, now, fingerprint);
  return { ...result, deduped: false, evicted };
}

/** Filter rows by attrs equality; shared by backends. */
export function matchesAttrs(row: MemoryRow, attrs: Record<string, unknown> | undefined): boolean {
  if (!attrs) return true;
  return Object.entries(attrs).every(([k, v]) => row.attrs[k] === v);
}

/**
 * Validate and clamp a similar-subjects query. Returns null when it can match
 * nothing (non-scalar attr value, no subject type).
 */
export function normalizeSimilarQuery(q: MemorySimilarQuery): (MemorySimilarQuery & { now: number }) | null {
  if (!q.org || !q.project || !q.subjectType) return null;
  const attrs: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(q.attrs ?? {})) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(k)) {
      throw new MemoryError("MEMORY_ATTRS_INVALID", `attr filter key "${k}" must match [A-Za-z0-9_.:-]{1,64}`);
    }
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
      attrs[k] = v;
    } else {
      return null;
    }
  }
  return {
    org: q.org,
    project: q.project,
    subjectType: q.subjectType,
    excludeSubjectKey: q.excludeSubjectKey ?? "",
    attrs,
    prefix: q.prefix || undefined,
    limit: Math.max(1, Math.min(Math.floor(q.limit), MEMORY_SIMILAR_MAX_SUBJECTS)),
    perSubject: Math.max(1, Math.min(Math.floor(q.perSubject), MEMORY_SIMILAR_MAX_PER_SUBJECT)),
    now: q.now ?? Date.now(),
  };
}

/** Group rows (already ordered subject-by-subject) into similar-subject groups. */
export function groupSimilar(rows: MemoryRow[]): MemorySimilarGroup[] {
  const out: MemorySimilarGroup[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.subjectKey === r.subjectKey) last.items.push(r);
    else out.push({ subjectKey: r.subjectKey, items: [r] });
  }
  return out;
}

/**
 * A {@link MemoryBackend} over a synchronous {@link MemoryTable} plus a
 * transaction runner.
 */
export class EngineMemoryBackend implements MemoryBackend {
  constructor(
    readonly kind: string,
    readonly durable: boolean,
    protected readonly table: MemoryTable,
    protected readonly transaction: <T>(fn: () => T) => T,
  ) {}

  async get(tuple: MemoryTuple, key: string, now = Date.now()): Promise<MemoryRow | null> {
    scopeOfTuple(tuple);
    const row = this.table.find(tuple, key);
    return row && !isExpired(row, now) ? row : null;
  }

  async list(tuple: MemoryTuple, opts: MemoryListOptions = {}): Promise<MemoryRow[]> {
    scopeOfTuple(tuple);
    const now = opts.now ?? Date.now();
    const limit = opts.limit !== undefined ? Math.max(0, opts.limit) : undefined;
    if (!opts.attrs || Object.keys(opts.attrs).length === 0) return this.table.list(tuple, opts.prefix, now, limit);
    const rows = this.table.list(tuple, opts.prefix, now).filter((r) => matchesAttrs(r, opts.attrs));
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }

  async similarSubjects(q: MemorySimilarQuery): Promise<MemorySimilarGroup[]> {
    const query = normalizeSimilarQuery(q);
    if (!query) return [];
    const rows = this.table.similar(query).filter((r) => matchesAttrs(r, query.attrs));
    return groupSimilar(rows);
  }

  async write(op: MemoryWriteOp): Promise<MemoryWriteResult> {
    return this.transaction(() => applyMemoryWrite(this.table, op));
  }

  async bindThread(binding: MemoryThreadBinding): Promise<void> {
    this.transaction(() => this.table.putThread({ ...binding, createdAt: binding.createdAt ?? Date.now() }));
  }

  async getThread(threadId: string): Promise<MemoryThreadBinding | null> {
    return this.table.getThread(threadId) ?? null;
  }

  async sweep(now = Date.now()): Promise<number> {
    return this.transaction(() => this.table.sweep(now, now - MEMORY_OP_RETENTION_MS));
  }
}
