/**
 * Ephemeral in-process memory backend. For tests and for the legacy
 * `ctx.store` adapter when no durable backend is configured.
 */
import { EngineMemoryBackend, matchesAttrs, type MemoryTable } from "./engine.js";
import { tupleKey } from "./scope.js";
import type { MemoryRow, MemorySimilarQuery, MemoryThreadBinding, MemoryTuple } from "./types.js";

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const live = (r: MemoryRow, now: number) => r.expiresAt === null || r.expiresAt > now;

class InMemoryTable implements MemoryTable {
  private nextId = 1;
  private readonly rows = new Map<number, MemoryRow>();
  private readonly byKey = new Map<string, number>();
  private readonly ops = new Map<string, { version: number; value: unknown; at: number; fingerprint: string | null }>();
  private readonly threads = new Map<string, MemoryThreadBinding>();
  /** Row ids per tuple, so per-scope operations don't scan every row. */
  private readonly byTuple = new Map<string, Set<number>>();

  constructor(private readonly maxItems: number) {}

  private k(t: MemoryTuple, key: string) {
    return `${tupleKey(t)}\u0001${key}`;
  }
  private inTuple(t: MemoryTuple): MemoryRow[] {
    const ids = this.byTuple.get(tupleKey(t));
    return ids ? [...ids].map((id) => this.rows.get(id)!) : [];
  }

  find(t: MemoryTuple, key: string) {
    const id = this.byKey.get(this.k(t, key));
    const r = id === undefined ? undefined : this.rows.get(id);
    return r ? clone(r) : undefined;
  }
  insert(row: Omit<MemoryRow, "id">) {
    const id = this.nextId++;
    this.rows.set(id, clone({ ...row, id }));
    this.byKey.set(this.k(row, row.key), id);
    const tk = tupleKey(row);
    let ids = this.byTuple.get(tk);
    if (!ids) this.byTuple.set(tk, (ids = new Set()));
    ids.add(id);
    // Process-wide bound: drop the oldest inserted rows (Map keeps insertion order).
    while (this.rows.size > this.maxItems) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined || oldest === id) break;
      this.remove(oldest);
    }
  }
  update(row: MemoryRow) {
    this.rows.set(row.id, clone(row));
  }
  remove(id: number) {
    const r = this.rows.get(id);
    if (!r) return;
    this.rows.delete(id);
    this.byKey.delete(this.k(r, r.key));
    const tk = tupleKey(r);
    const ids = this.byTuple.get(tk);
    ids?.delete(id);
    if (ids && ids.size === 0) this.byTuple.delete(tk);
  }
  removeExpired(t: MemoryTuple, now: number) {
    for (const r of this.inTuple(t)) if (!live(r, now)) this.remove(r.id);
  }
  usage(t: MemoryTuple, now: number) {
    let items = 0;
    let bytes = 0;
    for (const r of this.inTuple(t)) if (live(r, now)) { items += 1; bytes += r.bytes; }
    return { items, bytes };
  }
  oldest(t: MemoryTuple, limit: number, excludeKey: string, now: number) {
    return this.inTuple(t)
      .filter((r) => live(r, now) && r.key !== excludeKey)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id - b.id)
      .slice(0, limit)
      .map(clone);
  }
  list(t: MemoryTuple, prefix: string | undefined, now: number, limit?: number) {
    const rows = this.inTuple(t)
      .filter((r) => live(r, now) && (prefix === undefined || r.key.startsWith(prefix)))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    return (limit !== undefined ? rows.slice(0, limit) : rows).map(clone);
  }
  similar(q: MemorySimilarQuery & { now: number }) {
    const byKey = new Map<string, MemoryRow[]>();
    for (const r of this.rows.values()) {
      if (r.org !== q.org || r.project !== q.project || r.subjectType !== q.subjectType) continue;
      if (r.graph !== "" || r.usr !== "" || r.subjectKey === "" || r.subjectKey === q.excludeSubjectKey) continue;
      if (!live(r, q.now) || (q.prefix !== undefined && !r.key.startsWith(q.prefix)) || !matchesAttrs(r, q.attrs)) continue;
      const list = byKey.get(r.subjectKey) ?? [];
      list.push(r);
      byKey.set(r.subjectKey, list);
    }
    const groups = [...byKey.entries()].map(([key, rows]) => ({
      key,
      rows: rows.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id),
    }));
    groups.sort((a, b) => b.rows[0]!.updatedAt - a.rows[0]!.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return groups.slice(0, q.limit).flatMap((g) => g.rows.slice(0, q.perSubject).map(clone));
  }
  touchSubject(org: string, project: string, type: string, key: string, expiresAt: number) {
    for (const r of this.rows.values()) {
      if (r.org === org && r.project === project && r.subjectType === type && r.subjectKey === key) r.expiresAt = expiresAt;
    }
  }
  oldestSubjects(org: string, project: string, type: string, now: number, excludeKey: string, keepNewest: number) {
    const last = new Map<string, number>();
    for (const r of this.rows.values()) {
      if (r.org !== org || r.project !== project || r.subjectType !== type || r.subjectKey === excludeKey || !live(r, now)) continue;
      last.set(r.subjectKey, Math.max(last.get(r.subjectKey) ?? 0, r.updatedAt));
    }
    const newestFirst = [...last.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
    return newestFirst.slice(keepNewest).reverse().map(([k]) => k);
  }
  removeSubject(org: string, project: string, type: string, key: string) {
    let n = 0;
    for (const r of [...this.rows.values()]) {
      if (r.org === org && r.project === project && r.subjectType === type && r.subjectKey === key) {
        this.remove(r.id);
        n += 1;
      }
    }
    return n;
  }
  opGet(opId: string) {
    const o = this.ops.get(opId);
    return o ? { version: o.version, value: clone(o.value), fingerprint: o.fingerprint } : undefined;
  }
  opGetMany(opIds: readonly string[]) {
    const out = new Map<string, { version: number; value: unknown; fingerprint: string | null }>();
    for (const id of opIds) {
      const got = this.opGet(id);
      if (got) out.set(id, got);
    }
    return out;
  }
  opPut(opId: string, result: { version: number; value: unknown }, now: number, fingerprint: string | null) {
    this.ops.set(opId, { ...clone(result), at: now, fingerprint });
  }
  putThread(b: MemoryThreadBinding) {
    if (!this.threads.has(b.threadId)) this.threads.set(b.threadId, { ...b });
  }
  getThread(threadId: string) {
    const b = this.threads.get(threadId);
    return b ? { ...b } : undefined;
  }
  sweep(now: number, opsBefore: number) {
    let n = 0;
    for (const r of [...this.rows.values()]) if (!live(r, now)) { this.remove(r.id); n += 1; }
    for (const [id, o] of [...this.ops.entries()]) if (o.at < opsBefore) this.ops.delete(id);
    return n;
  }
}

export interface InMemoryMemoryBackendOptions {
  /**
   * Process-wide item cap (default 100,000). Past it the oldest inserted items
   * are dropped, so a long-lived host sharing one backend stays bounded.
   */
  maxItems?: number | undefined;
}

/** Create a non-durable, process-local memory backend. */
export function createInMemoryMemoryBackend(opts: InMemoryMemoryBackendOptions = {}): EngineMemoryBackend {
  const maxItems = Math.max(1, opts.maxItems ?? 100_000);
  return new EngineMemoryBackend("memory", false, new InMemoryTable(maxItems), (fn) => fn());
}
