/**
 * Backend-independent write semantics for scoped memory.
 *
 * Backends implement the small {@link MemoryTable} interface (synchronous, e.g.
 * sqlite) or {@link AsyncMemoryTable} (e.g. postgres) and run one write inside
 * one transaction. Both drive the same write program, so every backend gets the
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
  type MemorySweepOptions,
  type MemoryThreadBinding,
  type MemoryTuple,
  type MemoryWriteOp,
  type MemoryWriteResult,
} from "./types.js";

/** Op ids older than this are swept. Long enough to cover any resume window. */
export const MEMORY_OP_RETENTION_MS = 30 * 86_400_000;

/**
 * Missing positional op ids in a row that end a scan for records an older
 * build wrote. A failed write burned an index and left no row, so one hole
 * is normal; a long run of holes means the attempt stopped.
 */
const LEGACY_OP_GAP = 8;
/** Positional indexes read at most, so a scan cannot walk forever. */
const LEGACY_OP_SCAN_MAX = 1024;
/** Positional ids fetched per query. One round trip covers the empty-attempt gap. */
const LEGACY_OP_BATCH = 128;

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
  /**
   * Live subject keys of a type in a project other than `excludeKey`, skipping
   * the `keepNewest` most recently written ones, least recently written first
   * (ties by subject key). These are the subjects to evict when a
   * new subject would exceed the per-type cap.
   */
  oldestSubjects(org: string, project: string, type: string, now: number, excludeKey: string, keepNewest: number): string[];
  removeSubject(org: string, project: string, type: string, key: string): number;
  opGet(opId: string): { version: number; value: unknown; fingerprint: string | null } | undefined;
  /** Batch {@link opGet}. Missing ids are omitted. */
  opGetMany(opIds: readonly string[]): Map<string, { version: number; value: unknown; fingerprint: string | null }>;
  /** Insert or replace the op record. */
  opPut(opId: string, result: { version: number; value: unknown }, now: number, fingerprint: string | null): void;
  /** Insert the binding unless the thread already has one (never overwrites). */
  putThread(b: MemoryThreadBinding): void;
  getThread(threadId: string): MemoryThreadBinding | undefined;
  sweep(now: number, opsBefore: number): number;
}

/** {@link MemoryTable} with every method returning a promise (network databases). */
export type AsyncMemoryTable = {
  [K in keyof MemoryTable]: (...args: Parameters<MemoryTable[K]>) => Promise<ReturnType<MemoryTable[K]>>;
};

/** One table call requested by the write program. */
interface TableCall {
  method: keyof MemoryTable;
  args: unknown[];
}

type Program<R> = Generator<TableCall, R, unknown>;

function* call<K extends keyof MemoryTable>(method: K, ...args: Parameters<MemoryTable[K]>): Program<ReturnType<MemoryTable[K]>> {
  return (yield { method, args }) as ReturnType<MemoryTable[K]>;
}

function invoke(table: MemoryTable | AsyncMemoryTable, c: TableCall): unknown {
  return (table[c.method] as (...a: unknown[]) => unknown).apply(table, c.args);
}

function runSync<R>(program: Program<R>, table: MemoryTable): R {
  let step = program.next();
  while (!step.done) step = program.next(invoke(table, step.value));
  return step.value;
}

async function runAsync<R>(program: Program<R>, table: AsyncMemoryTable): Promise<R> {
  let step = program.next();
  while (!step.done) step = program.next(await invoke(table, step.value));
  return step.value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isExpired(row: { expiresAt: number | null }, now: number): boolean {
  return row.expiresAt !== null && row.expiresAt <= now;
}

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Refuse text that some backend cannot store, anywhere in a string that
 * reaches one: scope tuple, key, prefix, thread id, op id, writer, value
 * (strings and object keys, at any depth) and attrs. NUL (U+0000) fails with
 * MEMORY_NUL_CHARACTER and a lone UTF-16 surrogate with MEMORY_LONE_SURROGATE.
 * Postgres text and jsonb hold neither, so every backend rejects them the same
 * way instead of only some failing.
 */
export function assertStorableText(what: string, value: unknown): void {
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (v.includes("\u0000")) {
        throw new MemoryError("MEMORY_NUL_CHARACTER", `${what} contains a NUL character (U+0000), which memory cannot store`);
      }
      if (LONE_SURROGATE.test(v)) {
        throw new MemoryError(
          "MEMORY_LONE_SURROGATE",
          `${what} contains a lone UTF-16 surrogate (half of an emoji or other astral character), which memory cannot store`,
        );
      }
    } else if (typeof v === "object" && v !== null && !seen.has(v)) {
      seen.add(v);
      if (Array.isArray(v)) stack.push(...v);
      else
        for (const [k, x] of Object.entries(v)) {
          stack.push(k, x);
        }
    }
  }
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
  return runSync(writeProgram(op), table);
}

/** {@link applyMemoryWrite} over an {@link AsyncMemoryTable}; same transaction rule. */
export function applyMemoryWriteAsync(table: AsyncMemoryTable, op: MemoryWriteOp): Promise<MemoryWriteResult> {
  return runAsync(writeProgram(op), table);
}

/** Every string a write sends to a backend must be storable everywhere (see {@link assertStorableText}). */
function assertWriteStorable(op: MemoryWriteOp): void {
  assertStorableText("memory scope", op.tuple);
  assertStorableText("memory key", op.key);
  assertStorableText(`value for "${op.key}"`, op.value);
  assertStorableText(`attrs for "${op.key}"`, op.attrs);
  assertStorableText(`field for "${op.key}"`, op.field);
  assertStorableText(`op id for "${op.key}"`, op.opId);
  assertStorableText(`writer for "${op.key}"`, [op.writtenBy, op.writtenByRun]);
}

type OpRecord = { version: number; value: unknown; fingerprint: string | null };
type LegacyLookup = { kind: "hit"; row: OpRecord; opId: string } | { kind: "none" } | { kind: "miss" };

/**
 * Find the `matchIndex`th positional record (0-based) whose fingerprint equals
 * `fingerprint`. Rows with a null fingerprint (written before that column
 * existed) do not match. An older build stored a different write at the same
 * index under `opId~fingerprint`; that row counts too.
 * `none`: the attempt has no positional rows. `miss`: rows exist, but not this one.
 */
function* lookupLegacy(fingerprint: string, matchIndex: number, opIdAt: (index: number) => string): Program<LegacyLookup> {
  let seen = 0;
  let misses = 0;
  let seenAny = false;
  for (let start = 0; start < LEGACY_OP_SCAN_MAX; start += LEGACY_OP_BATCH) {
    const end = Math.min(start + LEGACY_OP_BATCH, LEGACY_OP_SCAN_MAX);
    const ids: string[] = [];
    for (let i = start; i < end; i++) ids.push(opIdAt(i));
    const rows = yield* call("opGetMany", ids);
    const altIds: string[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row && row.fingerprint !== fingerprint) altIds.push(`${id}~${fingerprint}`);
    }
    const alts = altIds.length > 0 ? yield* call("opGetMany", altIds) : undefined;
    for (const id of ids) {
      const row = rows.get(id);
      let hit: OpRecord | undefined;
      if (row?.fingerprint === fingerprint) hit = row;
      else if (row && alts) {
        const alt = alts.get(`${id}~${fingerprint}`);
        if (alt?.fingerprint === fingerprint) hit = alt;
      }
      if (hit) {
        const opId = hit === row ? id : `${id}~${fingerprint}`;
        if (seen === matchIndex) return { kind: "hit", row: hit, opId };
        seen += 1;
        seenAny = true;
        misses = 0;
        continue;
      }
      if (!row) {
        misses += 1;
        if (misses >= LEGACY_OP_GAP) return seenAny ? { kind: "miss" } : { kind: "none" };
      } else {
        seenAny = true;
        misses = 0;
      }
    }
  }
  return seenAny ? { kind: "miss" } : { kind: "none" };
}

function* writeProgram(op: MemoryWriteOp): Program<MemoryWriteResult> {
  const now = op.now ?? Date.now();
  const t = op.tuple;
  const scope = scopeOfTuple(t);
  const limits = op.limits;
  assertWriteStorable(op);
  validateMemoryKey(op.key, limits.keyChars);

  const fingerprint = op.opId ? (op.fingerprint ?? writeFingerprint(op)) : null;
  // The row this write is recorded under. The same id and fingerprint is a
  // replay. A different fingerprint under that id is applied once and stored
  // as opId~fingerprint, so alternating payloads each apply once and the first
  // record stays put.
  let opKey = op.opId;
  let primaryAbsent = false;
  if (op.opId && fingerprint !== null) {
    const prior = yield* call("opGet", op.opId);
    if (prior?.fingerprint === fingerprint) {
      return { version: prior.version, value: prior.value, deduped: true, evicted: 0 };
    }
    if (prior) {
      // An idempotency key names one operation. A different kind, scope or
      // memory key under that key is an error, not a second write and not a
      // silent replay.
      if (op.rejectFingerprintMismatch) {
        throw new MemoryError(
          "MEMORY_IDEMPOTENCY_CONFLICT",
          `idempotency key for "${op.key}" was already used for a different operation (kind, scope, or key)`,
          { key: op.key, kind: op.kind },
        );
      }
      opKey = `${op.opId}~${fingerprint}`;
      const alt = yield* call("opGet", opKey);
      if (alt?.fingerprint === fingerprint) {
        return { version: alt.version, value: alt.value, deduped: true, evicted: 0 };
      }
    } else {
      primaryAbsent = true;
    }
  }

  // Older builds keyed the id by call order. On a miss, adopt the Nth positional
  // row with this fingerprint (a reordered or repeated write still matches) and
  // copy it under the new id. A null fingerprint does not match. The empty
  // prefix of an attempt is one batched read. Tool calls ask for one exact
  // index instead, the write number shared across that agent attempt.
  let reportLegacyAbsent = false;
  if (primaryAbsent && op.opId && fingerprint !== null && op.legacyOpIdAt && op.legacyMatchIndex !== undefined) {
    if (op.legacyExact) {
      const id = op.legacyOpIdAt(op.legacyMatchIndex);
      const row = yield* call("opGet", id);
      let hitId = id;
      let hit: OpRecord | undefined;
      if (row?.fingerprint === fingerprint) hit = row;
      else if (row) {
        const altId = `${id}~${fingerprint}`;
        const alt = yield* call("opGet", altId);
        if (alt?.fingerprint === fingerprint) {
          hit = alt;
          hitId = altId;
        }
      }
      if (hit && (op.legacyClaim?.(hitId) ?? true)) {
        yield* call("opPut", op.opId, { version: hit.version, value: hit.value }, now, fingerprint);
        return { version: hit.version, value: hit.value, deduped: true, evicted: 0 };
      }
    } else {
      const gapIds = Array.from({ length: LEGACY_OP_GAP }, (_, i) => op.legacyOpIdAt!(i));
      const probeIds = op.legacySentinelId ? [...gapIds, op.legacySentinelId] : gapIds;
      const probed = yield* call("opGetMany", probeIds);
      const sentinelHit = op.legacySentinelId !== undefined && probed.has(op.legacySentinelId);
      const gapEmpty = gapIds.every((id) => !probed.has(id));
      if (sentinelHit || gapEmpty) {
        reportLegacyAbsent = true;
        if (gapEmpty && !sentinelHit && op.legacySentinelId) {
          yield* call("opPut", op.legacySentinelId, { version: 0, value: null }, now, "nolegacy");
        }
      } else {
        const found = yield* lookupLegacy(fingerprint, op.legacyMatchIndex, op.legacyOpIdAt);
        if (found.kind === "hit" && (op.legacyClaim?.(found.opId) ?? true)) {
          yield* call("opPut", op.opId, { version: found.row.version, value: found.row.value }, now, fingerprint);
          return { version: found.row.version, value: found.row.value, deduped: true, evicted: 0 };
        }
        if (found.kind === "none") reportLegacyAbsent = true;
      }
    }
  }

  yield* call("removeExpired", t, now);
  let existing = yield* call("find", t, op.key);
  if (existing && isExpired(existing, now)) {
    yield* call("remove", existing.id);
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
    if (existing) yield* call("remove", existing.id);
    const result = { version: 0, value: null };
    if (opKey) yield* call("opPut", opKey, result, now, fingerprint);
    return { ...result, deduped: false, evicted: 0, ...(reportLegacyAbsent ? { legacyAbsent: true } : {}) };
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
  const usage = yield* call("usage", t, now);
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
    const victims = yield* call("oldest", t, Math.max(1, liveItems - limits.itemsPerScope + 16), op.key, now);
    for (const v of victims) {
      if (liveItems <= limits.itemsPerScope && total <= limits.bytesPerScope) break;
      yield* call("remove", v.id);
      liveItems -= 1;
      total -= v.bytes;
      evicted += 1;
    }
    while (total > limits.bytesPerScope) {
      const more = yield* call("oldest", t, 16, op.key, now);
      if (more.length === 0) break;
      for (const v of more) {
        if (total <= limits.bytesPerScope) break;
        yield* call("remove", v.id);
        total -= v.bytes;
        evicted += 1;
      }
    }
  }

  // ── subjects per type cap (oldest subject evicted) ───────────────────────
  if (scope === "subject" && usage.items === 0) {
    // Only the subjects past the cap come back, so this stays one indexed query.
    const keep = Math.max(0, limits.subjectsPerType - 1);
    const victims = yield* call("oldestSubjects", t.org, t.project, t.subjectType, now, t.subjectKey, keep);
    for (const k of victims) evicted += yield* call("removeSubject", t.org, t.project, t.subjectType, k);
  }

  const version = (existing?.version ?? 0) + 1;
  if (existing) {
    yield* call("update", {
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
    yield* call("insert", {
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
    yield* call("touchSubject", t.org, t.project, t.subjectType, t.subjectKey, expiresAt);
  }

  const result = { version, value };
  if (opKey) yield* call("opPut", opKey, result, now, fingerprint);
  return { ...result, deduped: false, evicted, ...(reportLegacyAbsent ? { legacyAbsent: true } : {}) };
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
  assertStorableText("similar-subjects query", [q.org, q.project, q.subjectType, q.excludeSubjectKey, q.prefix, q.attrs]);
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

function opsCutoff(now: number, opts: MemorySweepOptions | undefined): number {
  const keep = opts?.opsRetentionMs ?? MEMORY_OP_RETENTION_MS;
  return now - Math.max(0, keep);
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
    assertStorableText("memory scope", tuple);
    assertStorableText("memory key", key);
    const row = this.table.find(tuple, key);
    return row && !isExpired(row, now) ? row : null;
  }

  async list(tuple: MemoryTuple, opts: MemoryListOptions = {}): Promise<MemoryRow[]> {
    scopeOfTuple(tuple);
    assertStorableText("memory scope", tuple);
    assertStorableText("search prefix and attrs", [opts.prefix, opts.attrs]);
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
    assertStorableText("thread binding", binding);
    this.transaction(() => this.table.putThread({ ...binding, createdAt: binding.createdAt ?? Date.now() }));
  }

  async getThread(threadId: string): Promise<MemoryThreadBinding | null> {
    assertStorableText("thread id", threadId);
    return this.table.getThread(threadId) ?? null;
  }

  async sweep(now = Date.now(), opts?: MemorySweepOptions): Promise<number> {
    return this.transaction(() => this.table.sweep(now, opsCutoff(now, opts)));
  }
}

/**
 * Write-time hooks an {@link AsyncMemoryTable} may add: serialize concurrent
 * writers to the same scope (and op id) before the write program reads.
 */
export interface AsyncMemoryWriteTable extends AsyncMemoryTable {
  lockForWrite?(tuple: MemoryTuple, opId: string | undefined): Promise<void>;
}

/**
 * A {@link MemoryBackend} over an {@link AsyncMemoryTable}. `reader` serves
 * reads outside a transaction; `transaction` runs `fn` with a table bound to
 * one database transaction, committing when it resolves and rolling back when
 * it throws.
 */
export class AsyncEngineMemoryBackend implements MemoryBackend {
  constructor(
    readonly kind: string,
    readonly durable: boolean,
    protected readonly reader: AsyncMemoryTable,
    protected readonly transaction: <T>(fn: (table: AsyncMemoryWriteTable) => Promise<T>) => Promise<T>,
  ) {}

  async get(tuple: MemoryTuple, key: string, now = Date.now()): Promise<MemoryRow | null> {
    scopeOfTuple(tuple);
    assertStorableText("memory scope", tuple);
    assertStorableText("memory key", key);
    const row = await this.reader.find(tuple, key);
    return row && !isExpired(row, now) ? row : null;
  }

  async list(tuple: MemoryTuple, opts: MemoryListOptions = {}): Promise<MemoryRow[]> {
    scopeOfTuple(tuple);
    assertStorableText("memory scope", tuple);
    assertStorableText("search prefix and attrs", [opts.prefix, opts.attrs]);
    const now = opts.now ?? Date.now();
    const limit = opts.limit !== undefined ? Math.max(0, opts.limit) : undefined;
    if (!opts.attrs || Object.keys(opts.attrs).length === 0) return this.reader.list(tuple, opts.prefix, now, limit);
    const rows = (await this.reader.list(tuple, opts.prefix, now)).filter((r) => matchesAttrs(r, opts.attrs));
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }

  async similarSubjects(q: MemorySimilarQuery): Promise<MemorySimilarGroup[]> {
    const query = normalizeSimilarQuery(q);
    if (!query) return [];
    const rows = (await this.reader.similar(query)).filter((r) => matchesAttrs(r, query.attrs));
    return groupSimilar(rows);
  }

  async write(op: MemoryWriteOp): Promise<MemoryWriteResult> {
    // Validate the tuple and the strings that key the locks before taking any lock.
    scopeOfTuple(op.tuple);
    assertWriteStorable(op);
    return this.transaction(async (table) => {
      await table.lockForWrite?.(op.tuple, op.opId);
      return applyMemoryWriteAsync(table, op);
    });
  }

  async bindThread(binding: MemoryThreadBinding): Promise<void> {
    assertStorableText("thread binding", binding);
    await this.reader.putThread({ ...binding, createdAt: binding.createdAt ?? Date.now() });
  }

  async getThread(threadId: string): Promise<MemoryThreadBinding | null> {
    assertStorableText("thread id", threadId);
    return (await this.reader.getThread(threadId)) ?? null;
  }

  async sweep(now = Date.now(), opts?: MemorySweepOptions): Promise<number> {
    return this.reader.sweep(now, opsCutoff(now, opts));
  }
}

/** Longest sweeper interval: the largest delay a Node timer honors (2^31-1 ms, about 24.8 days). */
export const MEMORY_SWEEP_MAX_INTERVAL_MS = 2_147_483_647;

export interface MemorySweeperOptions extends MemorySweepOptions {
  /** Time between sweeps. Default 1h; at least 1s; above MEMORY_SWEEP_MAX_INTERVAL_MS throws. */
  intervalMs?: number | undefined;
  /** Called with each sweep's removed-row count. */
  onSweep?: ((removed: number) => void) | undefined;
  /** Called when a sweep fails; the sweeper keeps running. Default: ignore. */
  onError?: ((err: unknown) => void) | undefined;
  /**
   * Replaces `backend.sweep` for each tick, e.g. so one replica of a fleet
   * claims each interval (`maybeSweepPostgres`). Returns rows removed.
   */
  sweep?: ((now: number) => Promise<number>) | undefined;
}

export interface MemorySweeper {
  /** Run one sweep now (also used by the timer). */
  sweepNow(): Promise<number>;
  stop(): void;
}

/**
 * Sweep expired items and old op records on a timer, for long-lived hosts.
 * The timer is unref'd, so it never keeps the process alive; overlapping ticks
 * are skipped.
 */
export function startMemorySweeper(backend: MemoryBackend, opts: MemorySweeperOptions = {}): MemorySweeper {
  const requested = opts.intervalMs ?? 3_600_000;
  // Node runs a timer whose delay is above 2^31-1 ms (or not a number) after 1 ms,
  // which would turn an hourly sweep into a busy loop.
  if (!Number.isFinite(requested) || requested > MEMORY_SWEEP_MAX_INTERVAL_MS) {
    throw new RangeError(
      `startMemorySweeper: intervalMs must be a finite number of milliseconds up to ${MEMORY_SWEEP_MAX_INTERVAL_MS} (about 24.8 days), got ${requested}`,
    );
  }
  const intervalMs = Math.max(1_000, requested);
  let running: Promise<number> | undefined;
  const sweepNow = (): Promise<number> => {
    if (running) return running;
    running = (async () => {
      try {
        const now = Date.now();
        const n = opts.sweep
          ? await opts.sweep(now)
          : await backend.sweep(now, opts.opsRetentionMs !== undefined ? { opsRetentionMs: opts.opsRetentionMs } : undefined);
        opts.onSweep?.(n);
        return n;
      } catch (err) {
        opts.onError?.(err);
        return 0;
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const timer = setInterval(() => void sweepNow(), intervalMs);
  timer.unref?.();
  return {
    sweepNow,
    stop() {
      clearInterval(timer);
    },
  };
}
