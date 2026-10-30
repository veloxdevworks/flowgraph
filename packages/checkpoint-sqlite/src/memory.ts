/**
 * SQLite scoped-memory backend. Lives in the checkpointer's database file and
 * shares its connection: `openSqliteBackend(path)` returns both the LangGraph
 * checkpointer and the memory backend.
 */
import Database from "better-sqlite3";
import type { Database as DB, Statement } from "better-sqlite3";
import {
  EngineMemoryBackend,
  checkGraphNameArgs,
  type GraphNameClaim,
  type GraphNameRecord,
  type GraphNameRegistry,
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
  {
    // Covering index for the per-type subject cap and cross-subject search
    // (group by subject without reading rows); memory-specific table names.
    // Files first migrated by an earlier release created fg_memory_subject_recent
    // in version 1; fresh files never do, hence IF EXISTS.
    version: 3,
    sql: `
CREATE INDEX fg_memory_subject_keys
  ON fg_memory_items (org, project, subject_type, subject_key, updated_at, expires_at, key) WHERE subject_type <> '';
DROP INDEX IF EXISTS fg_memory_subject_recent;
ALTER TABLE fg_threads RENAME TO fg_memory_threads;
ALTER TABLE fg_meta RENAME TO fg_memory_meta;
`,
  },
  {
    // Graph-name ownership for multi-user servers: the first registrant of a
    // name within an org owns it.
    version: 4,
    sql: `
CREATE TABLE fg_graph_names (
  org        TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  owner      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org, name)
) WITHOUT ROWID;
`,
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
        WHERE org = ? AND project = ? AND subject_type = ? AND subject_type <> ''
          AND subject_key <> ? AND ${LIVE}
        GROUP BY subject_key ORDER BY last DESC, k DESC LIMIT -1 OFFSET ?`),
      removeSubject: p(`DELETE FROM fg_memory_items
        WHERE org = ? AND project = ? AND graph = '' AND usr = '' AND subject_type = ? AND subject_key = ?`),
      opGet: p(`SELECT version, value, fingerprint FROM fg_memory_ops WHERE op_id = ?`),
      opPut: p(`INSERT OR REPLACE INTO fg_memory_ops (op_id, version, value, applied_at, fingerprint) VALUES (?, ?, ?, ?, ?)`),
      putThread: p(`INSERT INTO fg_memory_threads
        (thread_id, org, project, graph, usr, subject_type, subject_key, principal_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (thread_id) DO NOTHING`),
      getThread: p(`SELECT * FROM fg_memory_threads WHERE thread_id = ?`),
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
    // Filter on one table alias; the same filter (and params) is used twice.
    const filter = (a: string): { sql: string; params: unknown[] } => {
      const conds = [
        // Subject rows always have graph = '' and usr = '' (table CHECK), so
        // those terms are left out and the covering subject index is used.
        `${a}.org = ?`, `${a}.project = ?`, `${a}.subject_type = ?`,
        `${a}.subject_type <> ''`, `${a}.subject_key <> ''`, `${a}.subject_key <> ?`,
        `(${a}.expires_at IS NULL OR ${a}.expires_at > ?)`,
      ];
      const params: unknown[] = [q.org, q.project, q.subjectType, q.excludeSubjectKey ?? "", q.now];
      if (q.prefix !== undefined) {
        conds.push(`substr(${a}.key, 1, length(?)) = ?`);
        params.push(q.prefix, q.prefix);
      }
      for (const [k, v] of Object.entries(q.attrs ?? {})) {
        const path = `$."${k}"`;
        if (v === null) {
          conds.push(`json_type(${a}.attrs, ?) = 'null'`);
          params.push(path);
        } else if (typeof v === "boolean") {
          conds.push(`json_type(${a}.attrs, ?) = '${v ? "true" : "false"}'`);
          params.push(path);
        } else if (typeof v === "number") {
          conds.push(`json_type(${a}.attrs, ?) IN ('integer', 'real') AND json_extract(${a}.attrs, ?) = ?`);
          params.push(path, path, v);
        } else {
          conds.push(`json_type(${a}.attrs, ?) = 'text' AND json_extract(${a}.attrs, ?) = ?`);
          params.push(path, path, String(v));
        }
      }
      return { sql: conds.join(" AND "), params };
    };
    // Pick the subjects first (grouped over the covering subject index when
    // there is no attrs filter), then rank rows of those subjects only.
    // CROSS JOIN keeps s as the outer loop in sqlite.
    const fs = filter("f");
    const fi = filter("i");
    const sql = `WITH s AS (
        SELECT f.subject_key AS sk, MAX(f.updated_at) AS last FROM fg_memory_items f
        WHERE ${fs.sql}
        GROUP BY f.subject_key ORDER BY last DESC, sk ASC LIMIT ?
      ),
      m AS (
        SELECT i.*, s.last AS last,
          ROW_NUMBER() OVER (PARTITION BY i.subject_key ORDER BY i.updated_at DESC, i.id DESC) AS rn
        FROM s CROSS JOIN fg_memory_items i
        WHERE i.subject_key = s.sk AND ${fi.sql}
      )
      SELECT * FROM m WHERE rn <= ? ORDER BY last DESC, subject_key ASC, rn ASC`;
    const params = [...fs.params, q.limit, ...fi.params, q.perSubject];
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
  opGetMany(opIds: readonly string[]) {
    const out = new Map<string, { version: number; value: unknown; fingerprint: string | null }>();
    if (opIds.length === 0) return out;
    const ph = opIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT op_id, version, value, fingerprint FROM fg_memory_ops WHERE op_id IN (${ph})`,
    ).all(...opIds) as Array<{ op_id: string; version: number; value: string | null; fingerprint: string | null }>;
    for (const r of rows) {
      out.set(r.op_id, {
        version: r.version,
        value: r.value === null ? null : (JSON.parse(r.value) as unknown),
        fingerprint: r.fingerprint,
      });
    }
    return out;
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
  const last = db.prepare(`SELECT value FROM fg_memory_meta WHERE key = 'memory.last_sweep'`).get() as
    | { value: string }
    | undefined;
  if (last && now - Number(last.value) < intervalMs) return 0;
  const n = await backend.sweep(now);
  db.prepare(
    `INSERT INTO fg_memory_meta (key, value) VALUES ('memory.last_sweep', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(String(now));
  return n;
}

export function openDatabase(dbPath: string, busyTimeoutMs = 5_000): SqliteDatabase {
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  return db;
}

/**
 * Graph-name registry in the memory database (table fg_graph_names, memory
 * schema 4). Runs migrations. A claim is one INSERT OR IGNORE plus a read, in
 * one IMMEDIATE transaction, so processes sharing the file agree on the owner.
 */
export function createSqliteGraphNameRegistry(db: SqliteDatabase): GraphNameRegistry {
  migrateMemorySchema(db);
  const insert = db.prepare(`INSERT OR IGNORE INTO fg_graph_names (org, name, owner, created_at) VALUES (?, ?, ?, ?)`);
  const select = db.prepare(`SELECT org, name, owner, created_at FROM fg_graph_names WHERE org = ? AND name = ?`);
  type Raw = { org: string; name: string; owner: string; created_at: number };
  const rec = (r: Raw): GraphNameRecord => ({ org: r.org, name: r.name, owner: r.owner, createdAt: Number(r.created_at) });
  const claim = db.transaction((org: string, name: string, owner: string, now: number): GraphNameClaim => {
    const created = insert.run(org, name, owner, now).changes === 1;
    return { ...rec(select.get(org, name) as Raw), created };
  });
  return {
    async claim(org, name, owner, now = Date.now()) {
      checkGraphNameArgs(org, name, owner);
      return claim.immediate(org, name, owner, now);
    },
    async get(org, name) {
      checkGraphNameArgs(org, name);
      const r = select.get(org, name) as Raw | undefined;
      return r ? rec(r) : undefined;
    },
  };
}
