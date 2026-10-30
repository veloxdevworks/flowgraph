/**
 * SQLite scoped-memory backend. Lives in the checkpointer's database file and
 * shares its connection: `openSqliteBackend(path)` returns both the LangGraph
 * checkpointer and the memory backend.
 */
import Database from "better-sqlite3";
import type { Database as DB, Statement } from "better-sqlite3";
import {
  EngineMemoryBackend,
  type MemoryRow,
  type MemorySimilarQuery,
  type MemoryTable,
  type MemoryThreadBinding,
  type MemoryTuple,
} from "@flowgraph/core";

export type SqliteDatabase = DB;

interface Migration {
  version: number;
  sql: string;
}

/** Forward-only migrations for component "memory". */
export const MEMORY_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE fg_memory_items (
  id             INTEGER PRIMARY KEY,
  org            TEXT    NOT NULL,
  project        TEXT    NOT NULL DEFAULT '',
  graph          TEXT    NOT NULL DEFAULT '',
  usr            TEXT    NOT NULL DEFAULT '',
  subject_type   TEXT    NOT NULL DEFAULT '',
  subject_key    TEXT    NOT NULL DEFAULT '',
  key            TEXT    NOT NULL CHECK (length(key) BETWEEN 1 AND 256),
  value          TEXT    NOT NULL CHECK (json_valid(value)),
  attrs          TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
  bytes          INTEGER NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  last_read_at   INTEGER,
  written_by_run TEXT,
  written_by     TEXT,
  UNIQUE (org, project, graph, usr, subject_type, subject_key, key),
  CHECK (org <> ''),
  CHECK ((subject_type = '') = (subject_key = '')
     AND (subject_type = '' OR (graph = '' AND usr = '' AND project <> ''))
     AND (usr = '' OR graph <> '')
     AND (graph = '' OR project <> ''))
);
CREATE INDEX fg_memory_scope_recent
  ON fg_memory_items (org, project, graph, usr, subject_type, subject_key, updated_at);
CREATE INDEX fg_memory_subject_recent
  ON fg_memory_items (org, project, subject_type, updated_at DESC) WHERE subject_type <> '';
CREATE INDEX fg_memory_expires
  ON fg_memory_items (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE fg_memory_ops (
  op_id      TEXT    PRIMARY KEY,
  version    INTEGER NOT NULL,
  value      TEXT,
  applied_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX fg_memory_ops_applied ON fg_memory_ops (applied_at);
CREATE TABLE fg_threads (
  thread_id    TEXT PRIMARY KEY,
  org          TEXT NOT NULL,
  project      TEXT NOT NULL,
  graph        TEXT NOT NULL,
  usr          TEXT NOT NULL DEFAULT '',
  subject_type TEXT NOT NULL DEFAULT '',
  subject_key  TEXT NOT NULL DEFAULT '',
  principal_id TEXT,
  created_at   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE fg_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`,
  },
  {
    // Op-id dedupe only matches the same write: tuple, key, kind and arguments.
    version: 2,
    sql: `ALTER TABLE fg_memory_ops ADD COLUMN fingerprint TEXT;`,
  },
];

/** Apply pending migrations in one IMMEDIATE transaction. Forward-only. */
export function migrateMemorySchema(db: DB): number {
  db.exec(`CREATE TABLE IF NOT EXISTS fg_schema_migrations (
    component  TEXT    NOT NULL,
    version    INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (component, version)
  ) WITHOUT ROWID`);
  const apply = db.transaction(() => {
    const row = db.prepare(`SELECT MAX(version) AS v FROM fg_schema_migrations WHERE component = 'memory'`).get() as
      | { v: number | null }
      | undefined;
    const current = row?.v ?? 0;
    const latest = MEMORY_MIGRATIONS[MEMORY_MIGRATIONS.length - 1]?.version ?? 0;
    if (current > latest) {
      throw new Error(
        `${db.name}: memory schema version ${current} is newer than this flowgraph supports (${latest}); upgrade flowgraph`,
      );
    }
    let applied = 0;
    for (const m of MEMORY_MIGRATIONS) {
      if (m.version <= current) continue;
      db.exec(m.sql);
      db.prepare(`INSERT INTO fg_schema_migrations (component, version, applied_at) VALUES ('memory', ?, ?)`).run(
        m.version,
        Date.now(),
      );
      applied += 1;
    }
    return applied;
  });
  return apply.immediate();
}

interface RawRow {
  id: number;
  org: string;
  project: string;
  graph: string;
  usr: string;
  subject_type: string;
  subject_key: string;
  key: string;
  value: string;
  attrs: string;
  bytes: number;
  version: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  written_by: string | null;
  written_by_run: string | null;
}

function fromRaw(r: RawRow): MemoryRow {
  return {
    id: r.id,
    org: r.org,
    project: r.project,
    graph: r.graph,
    usr: r.usr,
    subjectType: r.subject_type,
    subjectKey: r.subject_key,
    key: r.key,
    value: JSON.parse(r.value) as unknown,
    attrs: JSON.parse(r.attrs) as MemoryRow["attrs"],
    bytes: r.bytes,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    writtenBy: r.written_by,
    writtenByRun: r.written_by_run,
  };
}

const T = `org = ? AND project = ? AND graph = ? AND usr = ? AND subject_type = ? AND subject_key = ?`;
const LIVE = `(expires_at IS NULL OR expires_at > ?)`;
const tp = (t: MemoryTuple) => [t.org, t.project, t.graph, t.usr, t.subjectType, t.subjectKey];

class SqliteMemoryTable implements MemoryTable {
  private readonly s: Record<string, Statement>;
  private readonly similarCache = new Map<string, Statement>();

  constructor(private readonly db: DB) {
    const p = (sql: string) => db.prepare(sql);
    this.s = {
      find: p(`SELECT * FROM fg_memory_items WHERE ${T} AND key = ?`),
      insert: p(`INSERT INTO fg_memory_items
        (org, project, graph, usr, subject_type, subject_key, key, value, attrs, bytes, version,
         created_at, updated_at, expires_at, written_by, written_by_run)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      update: p(`UPDATE fg_memory_items SET value = ?, attrs = ?, bytes = ?, version = ?, updated_at = ?,
        expires_at = ?, written_by = ?, written_by_run = ? WHERE id = ?`),
      remove: p(`DELETE FROM fg_memory_items WHERE id = ?`),
      removeExpired: p(`DELETE FROM fg_memory_items WHERE ${T} AND expires_at IS NOT NULL AND expires_at <= ?`),
      usage: p(`SELECT COUNT(*) AS items, COALESCE(SUM(bytes), 0) AS bytes FROM fg_memory_items WHERE ${T} AND ${LIVE}`),
      oldest: p(`SELECT * FROM fg_memory_items WHERE ${T} AND key <> ? AND ${LIVE} ORDER BY updated_at ASC, id ASC LIMIT ?`),
      list: p(`SELECT * FROM fg_memory_items WHERE ${T} AND ${LIVE}
        AND (? IS NULL OR substr(key, 1, length(?)) = ?) ORDER BY updated_at DESC, id DESC LIMIT ?`),
      touchSubject: p(`UPDATE fg_memory_items SET expires_at = ?
        WHERE org = ? AND project = ? AND graph = '' AND usr = '' AND subject_type = ? AND subject_key = ?`),
      oldestSubjects: p(`SELECT subject_key AS k, MAX(updated_at) AS last FROM fg_memory_items
        WHERE org = ? AND project = ? AND graph = '' AND usr = '' AND subject_type = ? AND subject_type <> ''
          AND subject_key <> ? AND ${LIVE}
        GROUP BY subject_key ORDER BY last DESC, k DESC LIMIT -1 OFFSET ?`),
      removeSubject: p(`DELETE FROM fg_memory_items
        WHERE org = ? AND project = ? AND graph = '' AND usr = '' AND subject_type = ? AND subject_key = ?`),
      opGet: p(`SELECT version, value, fingerprint FROM fg_memory_ops WHERE op_id = ?`),
      opPut: p(`INSERT OR REPLACE INTO fg_memory_ops (op_id, version, value, applied_at, fingerprint) VALUES (?, ?, ?, ?, ?)`),
      putThread: p(`INSERT INTO fg_threads
        (thread_id, org, project, graph, usr, subject_type, subject_key, principal_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (thread_id) DO NOTHING`),
      getThread: p(`SELECT * FROM fg_threads WHERE thread_id = ?`),
      sweepItems: p(`DELETE FROM fg_memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?`),
      sweepOps: p(`DELETE FROM fg_memory_ops WHERE applied_at < ?`),
    };
  }

  find(t: MemoryTuple, key: string) {
    const r = this.s["find"]!.get(...tp(t), key) as RawRow | undefined;
    return r ? fromRaw(r) : undefined;
  }
  insert(row: Omit<MemoryRow, "id">) {
    this.s["insert"]!.run(
      ...tp(row), row.key, JSON.stringify(row.value), JSON.stringify(row.attrs), row.bytes, row.version,
      row.createdAt, row.updatedAt, row.expiresAt, row.writtenBy, row.writtenByRun,
    );
  }
  update(row: MemoryRow) {
    this.s["update"]!.run(
      JSON.stringify(row.value), JSON.stringify(row.attrs), row.bytes, row.version, row.updatedAt,
      row.expiresAt, row.writtenBy, row.writtenByRun, row.id,
    );
  }
  remove(id: number) {
    this.s["remove"]!.run(id);
  }
  removeExpired(t: MemoryTuple, now: number) {
    this.s["removeExpired"]!.run(...tp(t), now);
  }
  usage(t: MemoryTuple, now: number) {
    return this.s["usage"]!.get(...tp(t), now) as { items: number; bytes: number };
  }
  oldest(t: MemoryTuple, limit: number, excludeKey: string, now: number) {
    return (this.s["oldest"]!.all(...tp(t), excludeKey, now, limit) as RawRow[]).map(fromRaw);
  }
  list(t: MemoryTuple, prefix: string | undefined, now: number, limit?: number) {
    const pfx = prefix ?? null;
    return (this.s["list"]!.all(...tp(t), now, pfx, pfx, pfx, limit ?? -1) as RawRow[]).map(fromRaw);
  }
  similar(q: MemorySimilarQuery & { now: number }) {
    const conds: string[] = [];
    const params: unknown[] = [q.org, q.project, q.subjectType, q.excludeSubjectKey ?? "", q.now];
    if (q.prefix !== undefined) {
      conds.push("substr(key, 1, length(?)) = ?");
      params.push(q.prefix, q.prefix);
    }
    for (const [k, v] of Object.entries(q.attrs ?? {})) {
      const path = `$."${k}"`;
      if (v === null) {
        conds.push("json_type(attrs, ?) = 'null'");
        params.push(path);
      } else if (typeof v === "boolean") {
        conds.push(`json_type(attrs, ?) = '${v ? "true" : "false"}'`);
        params.push(path);
      } else if (typeof v === "number") {
        conds.push("json_type(attrs, ?) IN ('integer', 'real') AND json_extract(attrs, ?) = ?");
        params.push(path, path, v);
      } else {
        conds.push("json_type(attrs, ?) = 'text' AND json_extract(attrs, ?) = ?");
        params.push(path, path, String(v));
      }
    }
    const sql = `WITH m AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY subject_key ORDER BY updated_at DESC, id DESC) AS rn,
          MAX(updated_at) OVER (PARTITION BY subject_key) AS last
        FROM fg_memory_items
        WHERE org = ? AND project = ? AND graph = '' AND usr = '' AND subject_type = ?
          AND subject_key <> '' AND subject_key <> ? AND ${LIVE}${conds.map((c) => ` AND ${c}`).join("")}
      ),
      s AS (SELECT DISTINCT subject_key AS sk, last FROM m ORDER BY last DESC, sk ASC LIMIT ?)
      SELECT m.* FROM m JOIN s ON m.subject_key = s.sk
      WHERE m.rn <= ?
      ORDER BY s.last DESC, s.sk ASC, m.rn ASC`;
    params.push(q.limit, q.perSubject);
    let stmt = this.similarCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.similarCache.size > 64) this.similarCache.clear();
      this.similarCache.set(sql, stmt);
    }
    return (stmt.all(...params) as RawRow[]).map(fromRaw);
  }
  touchSubject(org: string, project: string, type: string, key: string, expiresAt: number) {
    this.s["touchSubject"]!.run(expiresAt, org, project, type, key);
  }
  oldestSubjects(org: string, project: string, type: string, now: number, excludeKey: string, keepNewest: number) {
    const rows = this.s["oldestSubjects"]!.all(org, project, type, excludeKey, now, keepNewest) as Array<{ k: string }>;
    return rows.map((r) => r.k).reverse();
  }
  removeSubject(org: string, project: string, type: string, key: string) {
    return this.s["removeSubject"]!.run(org, project, type, key).changes;
  }
  opGet(opId: string) {
    const r = this.s["opGet"]!.get(opId) as { version: number; value: string | null; fingerprint: string | null } | undefined;
    return r
      ? { version: r.version, value: r.value === null ? null : (JSON.parse(r.value) as unknown), fingerprint: r.fingerprint }
      : undefined;
  }
  opPut(opId: string, result: { version: number; value: unknown }, now: number, fingerprint: string | null) {
    this.s["opPut"]!.run(opId, result.version, JSON.stringify(result.value ?? null), now, fingerprint);
  }
  putThread(b: MemoryThreadBinding) {
    this.s["putThread"]!.run(
      b.threadId, b.org, b.project, b.graph, b.usr, b.subjectType, b.subjectKey, b.principalId ?? null,
      b.createdAt ?? Date.now(),
    );
  }
  getThread(threadId: string) {
    const r = this.s["getThread"]!.get(threadId) as
      | {
          thread_id: string; org: string; project: string; graph: string; usr: string;
          subject_type: string; subject_key: string; principal_id: string | null; created_at: number;
        }
      | undefined;
    if (!r) return undefined;
    return {
      threadId: r.thread_id,
      org: r.org,
      project: r.project,
      graph: r.graph,
      usr: r.usr,
      subjectType: r.subject_type,
      subjectKey: r.subject_key,
      principalId: r.principal_id,
      createdAt: r.created_at,
    };
  }
  sweep(now: number, opsBefore: number) {
    const n = this.s["sweepItems"]!.run(now).changes;
    this.s["sweepOps"]!.run(opsBefore);
    return n;
  }
}

export interface SqliteMemoryBackend extends EngineMemoryBackend {
  readonly db: SqliteDatabase;
}

/**
 * Scoped memory over an open better-sqlite3 connection. Runs migrations.
 * Each write is one BEGIN IMMEDIATE transaction, so increments/appends/CAS are
 * atomic across processes sharing the file (WAL + busy_timeout).
 */
export function createSqliteMemoryBackend(db: SqliteDatabase): SqliteMemoryBackend {
  migrateMemorySchema(db);
  const table = new SqliteMemoryTable(db);
  const backend = new EngineMemoryBackend("sqlite", db.name !== ":memory:", table, <R>(fn: () => R): R =>
    db.transaction(fn).immediate(),
  ) as SqliteMemoryBackend;
  Object.defineProperty(backend, "db", { value: db, enumerable: false });
  return backend;
}

/** Sweep expired rows when the last sweep is older than `intervalMs`. */
export async function maybeSweep(backend: SqliteMemoryBackend, intervalMs: number, now = Date.now()): Promise<number> {
  const db = backend.db;
  const last = db.prepare(`SELECT value FROM fg_meta WHERE key = 'memory.last_sweep'`).get() as
    | { value: string }
    | undefined;
  if (last && now - Number(last.value) < intervalMs) return 0;
  const n = await backend.sweep(now);
  db.prepare(
    `INSERT INTO fg_meta (key, value) VALUES ('memory.last_sweep', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(String(now));
  return n;
}

export function openDatabase(dbPath: string, busyTimeoutMs = 5_000): SqliteDatabase {
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  return db;
}
