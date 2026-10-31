/**
 * Postgres scoped-memory backend. Lives next to the PostgresSaver checkpoint
 * tables (same database and schema) and can share its connection pool:
 * `openPostgresBackend(url)` returns both the checkpointer and the memory
 * backend over one pool.
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  AsyncEngineMemoryBackend,
  scopeOfTuple,
  type AsyncMemoryWriteTable,
  checkGraphNameArgs,
  checkThreadOwnerArgs,
  type ThreadOwnerRecord,
  type ThreadOwnerRegistry,
  type GraphNameRecord,
  type GraphNameRegistry,
  type MemoryRow,
  type MemorySimilarQuery,
  type MemoryThreadBinding,
  type MemoryTuple,
} from "@flowgraph/core";

/** Anything that can run a query: the pool or one checked-out client. */
type Queryable = Pick<Pool, "query"> | PoolClient;

interface Migration {
  version: number;
  sql: string;
}

/**
 * Forward-only migrations for component "memory". Version numbers and schema
 * semantics match the sqlite backend; `{s}` is the quoted schema name.
 */
export const POSTGRES_MEMORY_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE {s}.fg_memory_items (
  id             BIGSERIAL PRIMARY KEY,
  org            TEXT COLLATE "C" NOT NULL,
  project        TEXT COLLATE "C" NOT NULL DEFAULT '',
  graph          TEXT COLLATE "C" NOT NULL DEFAULT '',
  usr            TEXT COLLATE "C" NOT NULL DEFAULT '',
  subject_type   TEXT COLLATE "C" NOT NULL DEFAULT '',
  subject_key    TEXT COLLATE "C" NOT NULL DEFAULT '',
  key            TEXT COLLATE "C" NOT NULL CHECK (char_length(key) BETWEEN 1 AND 256),
  value          JSON    NOT NULL,
  attrs          JSONB   NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attrs) = 'object'),
  bytes          INTEGER NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     BIGINT  NOT NULL,
  updated_at     BIGINT  NOT NULL,
  expires_at     BIGINT,
  last_read_at   BIGINT,
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
  ON {s}.fg_memory_items (org, project, graph, usr, subject_type, subject_key, updated_at);
CREATE INDEX fg_memory_expires
  ON {s}.fg_memory_items (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE {s}.fg_memory_ops (
  op_id      TEXT COLLATE "C" PRIMARY KEY,
  version    INTEGER NOT NULL,
  value      JSON,
  applied_at BIGINT  NOT NULL
);
CREATE INDEX fg_memory_ops_applied ON {s}.fg_memory_ops (applied_at);
CREATE TABLE {s}.fg_memory_threads (
  thread_id    TEXT COLLATE "C" PRIMARY KEY,
  org          TEXT NOT NULL,
  project      TEXT NOT NULL,
  graph        TEXT NOT NULL,
  usr          TEXT NOT NULL DEFAULT '',
  subject_type TEXT NOT NULL DEFAULT '',
  subject_key  TEXT NOT NULL DEFAULT '',
  principal_id TEXT,
  created_at   BIGINT NOT NULL
);
CREATE TABLE {s}.fg_memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    // Op-id dedupe only matches the same write: tuple, key, kind and arguments.
    version: 2,
    sql: `ALTER TABLE {s}.fg_memory_ops ADD COLUMN fingerprint TEXT;`,
  },
  {
    // Covering index for the per-type subject cap and cross-subject search.
    // Schemas first migrated by an earlier build created fg_memory_subject_recent
    // in version 1; fresh ones never do, hence IF EXISTS. Plain CREATE INDEX,
    // not CONCURRENTLY: migrations run in one transaction with their version
    // row (CONCURRENTLY cannot run inside one, and a failed concurrent build
    // leaves an invalid index that IF NOT EXISTS would then skip), and this
    // table is new in the same release, so the build never locks a large table.
    version: 3,
    sql: `
CREATE INDEX fg_memory_subject_keys
  ON {s}.fg_memory_items (org, project, subject_type, subject_key, updated_at) INCLUDE (expires_at, key)
  WHERE subject_type <> '';
DROP INDEX IF EXISTS {s}.fg_memory_subject_recent;
`,
  },
  {
    // Graph-name ownership for multi-user servers: the first registrant of a
    // name within an org owns it.
    version: 4,
    sql: `
CREATE TABLE {s}.fg_graph_names (
  org        TEXT   COLLATE "C" NOT NULL,
  name       TEXT   COLLATE "C" NOT NULL,
  owner      TEXT   COLLATE "C" NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (org, name)
);
`,
  },
  {
    // Thread ownership for multi-user servers: the principal that started a
    // thread id first owns it. Lives next to the checkpoint tables so every
    // replica that can load a thread's checkpoints sees its owner.
    version: 5,
    sql: `
CREATE TABLE {s}.fg_thread_owners (
  thread_id  TEXT   COLLATE "C" NOT NULL PRIMARY KEY,
  owner      TEXT   COLLATE "C" NOT NULL,
  org        TEXT   COLLATE "C" NOT NULL,
  created_at BIGINT NOT NULL
);
`,
  },
];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function quoteSchema(schema: string): string {
  if (!IDENT.test(schema)) throw new Error(`invalid postgres schema name ${JSON.stringify(schema)}`);
  return `"${schema}"`;
}

/** Transaction-scoped advisory lock on a text key. */
const LOCK = (param: string) => `pg_advisory_xact_lock(hashtextextended(${param}, 0))`;

/**
 * Apply pending migrations in one transaction under an advisory lock, so
 * concurrent starts serialize and each migration runs once. Forward-only;
 * refuses a schema migrated by a newer flowgraph.
 */
export async function migratePostgresMemorySchema(pool: Pool, schema = "public"): Promise<number> {
  const s = quoteSchema(schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query(`SELECT ${LOCK("$1")}`, [`flowgraph:memory:migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.fg_schema_migrations (
      component  TEXT    NOT NULL,
      version    INTEGER NOT NULL,
      applied_at BIGINT  NOT NULL,
      PRIMARY KEY (component, version)
    )`);
    const r = await client.query<{ v: number | null }>(
      `SELECT MAX(version) AS v FROM ${s}.fg_schema_migrations WHERE component = 'memory'`,
    );
    const current = r.rows[0]?.v ?? 0;
    const latest = POSTGRES_MEMORY_MIGRATIONS[POSTGRES_MEMORY_MIGRATIONS.length - 1]?.version ?? 0;
    if (current > latest) {
      throw new Error(
        `postgres schema ${schema}: memory schema version ${current} is newer than this flowgraph supports (${latest}); upgrade flowgraph`,
      );
    }
    let applied = 0;
    for (const m of POSTGRES_MEMORY_MIGRATIONS) {
      if (m.version <= current) continue;
      await client.query(m.sql.replaceAll("{s}", s));
      await client.query(`INSERT INTO ${s}.fg_schema_migrations (component, version, applied_at) VALUES ('memory', $1, $2)`, [
        m.version,
        Date.now(),
      ]);
      applied += 1;
    }
    await client.query("COMMIT");
    return applied;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface RawRow {
  id: string | number;
  org: string;
  project: string;
  graph: string;
  usr: string;
  subject_type: string;
  subject_key: string;
  key: string;
  value: unknown;
  attrs: MemoryRow["attrs"];
  bytes: number;
  version: number;
  created_at: string | number;
  updated_at: string | number;
  expires_at: string | number | null;
  written_by: string | null;
  written_by_run: string | null;
}

function fromRaw(r: RawRow): MemoryRow {
  return {
    id: Number(r.id),
    org: r.org,
    project: r.project,
    graph: r.graph,
    usr: r.usr,
    subjectType: r.subject_type,
    subjectKey: r.subject_key,
    key: r.key,
    value: r.value,
    attrs: r.attrs ?? {},
    bytes: Number(r.bytes),
    version: Number(r.version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    writtenBy: r.written_by,
    writtenByRun: r.written_by_run,
  };
}

const T = `org = $1 AND project = $2 AND graph = $3 AND usr = $4 AND subject_type = $5 AND subject_key = $6`;
const live = (p: string, a = "") => `(${a}expires_at IS NULL OR ${a}expires_at > ${p})`;
const tp = (t: MemoryTuple) => [t.org, t.project, t.graph, t.usr, t.subjectType, t.subjectKey];

/** Rows deleted per sweep statement, so a large sweep never holds long locks. */
const SWEEP_BATCH = 5_000;

/** Lock key for writers that may touch the same rows: one scope, or every subject of a type. */
export function memoryWriteLockKey(schema: string, t: MemoryTuple): string {
  const parts = scopeOfTuple(t) === "subject" ? ["subject-type", t.org, t.project, t.subjectType] : ["scope", ...tp(t)];
  return `flowgraph:memory:${schema}:${JSON.stringify(parts)}`;
}

class PostgresMemoryTable implements AsyncMemoryWriteTable {
  constructor(
    private readonly db: Queryable,
    private readonly s: string,
    private readonly schema: string,
    /** Inside a write transaction: lock rows read for update. */
    private readonly inTx: boolean,
  ) {}

  private async q<R extends QueryResultRow>(sql: string, params: unknown[] = []) {
    return this.db.query<R>(sql, params);
  }

  async lockForWrite(t: MemoryTuple, opId: string | undefined) {
    // Always scope first, then op id, so two writers never wait on each other in a cycle.
    const keys = [memoryWriteLockKey(this.schema, t)];
    if (opId) keys.push(`flowgraph:memory:${this.schema}:op:${opId}`);
    await this.q(`SELECT ${keys.map((_, i) => LOCK(`$${i + 1}`)).join(", ")}`, keys);
  }

  async find(t: MemoryTuple, key: string) {
    const r = await this.q<RawRow>(
      `SELECT * FROM ${this.s}.fg_memory_items WHERE ${T} AND key = $7${this.inTx ? " FOR UPDATE" : ""}`,
      [...tp(t), key],
    );
    return r.rows[0] ? fromRaw(r.rows[0]) : undefined;
  }
  async insert(row: Omit<MemoryRow, "id">) {
    await this.q(
      `INSERT INTO ${this.s}.fg_memory_items
        (org, project, graph, usr, subject_type, subject_key, key, value, attrs, bytes, version,
         created_at, updated_at, expires_at, written_by, written_by_run)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)`,
      [
        ...tp(row), row.key, JSON.stringify(row.value), JSON.stringify(row.attrs), row.bytes, row.version,
        row.createdAt, row.updatedAt, row.expiresAt, row.writtenBy, row.writtenByRun,
      ],
    );
  }
  async update(row: MemoryRow) {
    await this.q(
      `UPDATE ${this.s}.fg_memory_items SET value = $1::json, attrs = $2::jsonb, bytes = $3, version = $4, updated_at = $5,
        expires_at = $6, written_by = $7, written_by_run = $8 WHERE id = $9`,
      [
        JSON.stringify(row.value), JSON.stringify(row.attrs), row.bytes, row.version, row.updatedAt,
        row.expiresAt, row.writtenBy, row.writtenByRun, row.id,
      ],
    );
  }
  async remove(id: number) {
    await this.q(`DELETE FROM ${this.s}.fg_memory_items WHERE id = $1`, [id]);
  }
  async removeExpired(t: MemoryTuple, now: number) {
    await this.q(`DELETE FROM ${this.s}.fg_memory_items WHERE ${T} AND expires_at IS NOT NULL AND expires_at <= $7`, [...tp(t), now]);
  }
  async usage(t: MemoryTuple, now: number) {
    const r = await this.q<{ items: string; bytes: string }>(
      `SELECT COUNT(*) AS items, COALESCE(SUM(bytes), 0) AS bytes FROM ${this.s}.fg_memory_items WHERE ${T} AND ${live("$7")}`,
      [...tp(t), now],
    );
    return { items: Number(r.rows[0]?.items ?? 0), bytes: Number(r.rows[0]?.bytes ?? 0) };
  }
  async oldest(t: MemoryTuple, limit: number, excludeKey: string, now: number) {
    const r = await this.q<RawRow>(
      `SELECT * FROM ${this.s}.fg_memory_items WHERE ${T} AND key <> $7 AND ${live("$8")}
        ORDER BY updated_at ASC, id ASC LIMIT $9`,
      [...tp(t), excludeKey, now, limit],
    );
    return r.rows.map(fromRaw);
  }
  async list(t: MemoryTuple, prefix: string | undefined, now: number, limit?: number) {
    const r = await this.q<RawRow>(
      `SELECT * FROM ${this.s}.fg_memory_items WHERE ${T} AND ${live("$7")}
        AND ($8::text IS NULL OR starts_with(key, $8::text)) ORDER BY updated_at DESC, id DESC LIMIT $9`,
      [...tp(t), now, prefix ?? null, limit ?? null],
    );
    return r.rows.map(fromRaw);
  }
  async similar(q: MemorySimilarQuery & { now: number }) {
    const params: unknown[] = [q.org, q.project, q.subjectType, q.excludeSubjectKey ?? "", q.now];
    const extra: string[] = [];
    if (q.prefix !== undefined) {
      params.push(q.prefix);
      extra.push(`starts_with({a}key, $${params.length}::text)`);
    }
    const attrs = q.attrs ?? {};
    if (Object.keys(attrs).length > 0) {
      // jsonb containment is type-exact for scalars: 2 never matches "2", true never matches 1.
      params.push(JSON.stringify(attrs));
      extra.push(`{a}attrs @> $${params.length}::jsonb`);
    }
    // Subject rows always have graph = '' and usr = '' (table CHECK).
    const filter = (a: string) =>
      [
        `${a}org = $1`, `${a}project = $2`, `${a}subject_type = $3`, `${a}subject_type <> ''`,
        `${a}subject_key <> ''`, `${a}subject_key <> $4`, live("$5", a), ...extra.map((e) => e.replaceAll("{a}", a)),
      ].join(" AND ");
    params.push(q.limit, q.perSubject);
    const nLimit = params.length - 1;
    const nPer = params.length;
    // Subjects first (grouped over the covering subject index), then at most
    // perSubject rows of each.
    const r = await this.q<RawRow>(
      `WITH s AS (
        SELECT f.subject_key AS sk, MAX(f.updated_at) AS last FROM ${this.s}.fg_memory_items f
        WHERE ${filter("f.")}
        GROUP BY f.subject_key ORDER BY last DESC, sk ASC LIMIT $${nLimit}
      )
      SELECT i.* FROM s CROSS JOIN LATERAL (
        SELECT * FROM ${this.s}.fg_memory_items i
        WHERE i.subject_key = s.sk AND ${filter("i.")}
        ORDER BY i.updated_at DESC, i.id DESC LIMIT $${nPer}
      ) i
      ORDER BY s.last DESC, s.sk ASC, i.updated_at DESC, i.id DESC`,
      params,
    );
    return r.rows.map(fromRaw);
  }
  async touchSubject(org: string, project: string, type: string, key: string, expiresAt: number) {
    await this.q(
      `UPDATE ${this.s}.fg_memory_items SET expires_at = $1
        WHERE org = $2 AND project = $3 AND graph = '' AND usr = '' AND subject_type = $4 AND subject_key = $5`,
      [expiresAt, org, project, type, key],
    );
  }
  async oldestSubjects(org: string, project: string, type: string, now: number, excludeKey: string, keepNewest: number) {
    const r = await this.q<{ k: string }>(
      `SELECT subject_key AS k, MAX(updated_at) AS last FROM ${this.s}.fg_memory_items
        WHERE org = $1 AND project = $2 AND subject_type = $3 AND subject_type <> '' AND subject_key <> $4 AND ${live("$5")}
        GROUP BY subject_key ORDER BY last DESC, k DESC OFFSET $6`,
      [org, project, type, excludeKey, now, keepNewest],
    );
    return r.rows.map((x) => x.k).reverse();
  }
  async removeSubject(org: string, project: string, type: string, key: string) {
    const r = await this.q(
      `DELETE FROM ${this.s}.fg_memory_items
        WHERE org = $1 AND project = $2 AND graph = '' AND usr = '' AND subject_type = $3 AND subject_key = $4`,
      [org, project, type, key],
    );
    return r.rowCount ?? 0;
  }
  async opGet(opId: string) {
    const r = await this.q<{ version: number; value: unknown; fingerprint: string | null }>(
      `SELECT version, value, fingerprint FROM ${this.s}.fg_memory_ops WHERE op_id = $1`,
      [opId],
    );
    const row = r.rows[0];
    return row ? { version: Number(row.version), value: row.value ?? null, fingerprint: row.fingerprint } : undefined;
  }
  async opPut(opId: string, result: { version: number; value: unknown }, now: number, fingerprint: string | null) {
    await this.q(
      `INSERT INTO ${this.s}.fg_memory_ops (op_id, version, value, applied_at, fingerprint) VALUES ($1, $2, $3::json, $4, $5)
        ON CONFLICT (op_id) DO UPDATE SET version = EXCLUDED.version, value = EXCLUDED.value,
          applied_at = EXCLUDED.applied_at, fingerprint = EXCLUDED.fingerprint`,
      [opId, result.version, JSON.stringify(result.value ?? null), now, fingerprint],
    );
  }
  async putThread(b: MemoryThreadBinding) {
    await this.q(
      `INSERT INTO ${this.s}.fg_memory_threads
        (thread_id, org, project, graph, usr, subject_type, subject_key, principal_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (thread_id) DO NOTHING`,
      [b.threadId, b.org, b.project, b.graph, b.usr, b.subjectType, b.subjectKey, b.principalId ?? null, b.createdAt ?? Date.now()],
    );
  }
  async getThread(threadId: string) {
    const r = await this.q<{
      thread_id: string; org: string; project: string; graph: string; usr: string;
      subject_type: string; subject_key: string; principal_id: string | null; created_at: string;
    }>(`SELECT * FROM ${this.s}.fg_memory_threads WHERE thread_id = $1`, [threadId]);
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      threadId: row.thread_id,
      org: row.org,
      project: row.project,
      graph: row.graph,
      usr: row.usr,
      subjectType: row.subject_type,
      subjectKey: row.subject_key,
      principalId: row.principal_id,
      createdAt: Number(row.created_at),
    };
  }
  /** Batched deletes that skip rows a writer holds, so a sweep never blocks writes. */
  async sweep(now: number, opsBefore: number) {
    let removed = 0;
    for (;;) {
      const r = await this.q(
        `DELETE FROM ${this.s}.fg_memory_items WHERE id IN (
          SELECT id FROM ${this.s}.fg_memory_items WHERE expires_at IS NOT NULL AND expires_at <= $1
          LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED)`,
        [now],
      );
      removed += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < SWEEP_BATCH) break;
    }
    for (;;) {
      const r = await this.q(
        `DELETE FROM ${this.s}.fg_memory_ops WHERE op_id IN (
          SELECT op_id FROM ${this.s}.fg_memory_ops WHERE applied_at < $1
          LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED)`,
        [opsBefore],
      );
      if ((r.rowCount ?? 0) < SWEEP_BATCH) break;
    }
    return removed;
  }
}

export interface PostgresMemoryBackend extends AsyncEngineMemoryBackend {
  readonly pool: Pool;
  readonly schema: string;
}

export interface PostgresMemoryOptions {
  /** Schema for the memory tables (same as the checkpointer's). Default "public". */
  schema?: string;
  /** Run migrations. Default true. */
  migrate?: boolean;
}

/** Deadlock / serialization failures: the transaction rolled back and is safe to retry. */
const RETRYABLE = new Set(["40P01", "40001"]);

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      // Pinned: the write program takes its locks first and then reads, which
      // is only correct when each statement sees the latest commit. Under a
      // database default of repeatable read the snapshot predates the lock.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (attempt < 4 && RETRYABLE.has((err as { code?: string }).code ?? "")) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Scoped memory over a pg Pool. Runs migrations. Each write is one
 * transaction that first takes an advisory lock on its scope (every subject
 * of a type, for subject scope) and op id, then reads with FOR UPDATE, so
 * increments, appends, CAS, eviction and op-id dedupe are atomic across
 * connections and hosts.
 */
export async function createPostgresMemoryBackend(pool: Pool, opts: PostgresMemoryOptions = {}): Promise<PostgresMemoryBackend> {
  const schema = opts.schema ?? "public";
  const s = quoteSchema(schema);
  if (opts.migrate !== false) await migratePostgresMemorySchema(pool, schema);
  const reader = new PostgresMemoryTable(pool, s, schema, false);
  const backend = new AsyncEngineMemoryBackend("postgres", true, reader, (fn) =>
    inTransaction(pool, (client) => fn(new PostgresMemoryTable(client, s, schema, true))),
  ) as PostgresMemoryBackend;
  Object.defineProperty(backend, "pool", { value: pool, enumerable: false });
  Object.defineProperty(backend, "schema", { value: schema, enumerable: false });
  return backend;
}

/**
 * Sweep expired rows when the last sweep is older than `intervalMs`. Only one
 * host claims each interval (advisory lock + fg_memory_meta), so a fleet
 * starting together sweeps once.
 */
export async function maybeSweepPostgres(backend: PostgresMemoryBackend, intervalMs: number, now = Date.now()): Promise<number> {
  const s = quoteSchema(backend.schema);
  const claimed = await inTransaction(backend.pool, async (c) => {
    const lock = await c.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok`, [
      `flowgraph:memory:${backend.schema}:sweep`,
    ]);
    if (!lock.rows[0]?.ok) return false;
    const last = await c.query<{ value: string }>(`SELECT value FROM ${s}.fg_memory_meta WHERE key = 'memory.last_sweep'`);
    if (last.rows[0] && now - Number(last.rows[0].value) < intervalMs) return false;
    await c.query(
      `INSERT INTO ${s}.fg_memory_meta (key, value) VALUES ('memory.last_sweep', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(now)],
    );
    return true;
  });
  return claimed ? backend.sweep(now) : 0;
}

/**
 * Graph-name registry in the memory schema (table fg_graph_names, memory
 * schema 4). A claim is one INSERT ... ON CONFLICT DO NOTHING followed by a
 * read of the winning row, so concurrent hosts agree on the owner.
 */
export async function createPostgresGraphNameRegistry(pool: Pool, opts: PostgresMemoryOptions = {}): Promise<GraphNameRegistry> {
  const schema = opts.schema ?? "public";
  const s = quoteSchema(schema);
  if (opts.migrate !== false) await migratePostgresMemorySchema(pool, schema);
  type Raw = { org: string; name: string; owner: string; created_at: string | number };
  const rec = (r: Raw): GraphNameRecord => ({ org: r.org, name: r.name, owner: r.owner, createdAt: Number(r.created_at) });
  const select = `SELECT org, name, owner, created_at FROM ${s}.fg_graph_names WHERE org = $1 AND name = $2`;
  return {
    async claim(org, name, owner, now = Date.now()) {
      checkGraphNameArgs(org, name, owner);
      const ins = await pool.query<Raw>(
        `INSERT INTO ${s}.fg_graph_names (org, name, owner, created_at) VALUES ($1, $2, $3, $4)
          ON CONFLICT (org, name) DO NOTHING RETURNING org, name, owner, created_at`,
        [org, name, owner, now],
      );
      if (ins.rows[0]) return { ...rec(ins.rows[0]), created: true };
      // The conflicting row is committed (ON CONFLICT waited for it), so a plain read sees it.
      const r = await pool.query<Raw>(select, [org, name]);
      return { ...rec(r.rows[0]!), created: false };
    },
    async get(org, name) {
      checkGraphNameArgs(org, name);
      const r = await pool.query<Raw>(select, [org, name]);
      return r.rows[0] ? rec(r.rows[0]) : undefined;
    },
  };
}

/**
 * Thread-owner registry in the memory schema (table fg_thread_owners, memory
 * schema 5). A claim is one INSERT ... ON CONFLICT DO NOTHING followed by a
 * read of the winning row, so concurrent hosts agree on the owner.
 */
export async function createPostgresThreadOwnerRegistry(pool: Pool, opts: PostgresMemoryOptions = {}): Promise<ThreadOwnerRegistry> {
  const schema = opts.schema ?? "public";
  const s = quoteSchema(schema);
  if (opts.migrate !== false) await migratePostgresMemorySchema(pool, schema);
  type Raw = { thread_id: string; owner: string; org: string; created_at: string | number };
  const rec = (r: Raw): ThreadOwnerRecord => ({ threadId: r.thread_id, owner: r.owner, org: r.org, createdAt: Number(r.created_at) });
  const select = `SELECT thread_id, owner, org, created_at FROM ${s}.fg_thread_owners WHERE thread_id = $1`;
  return {
    async claim(threadId, owner, org, now = Date.now()) {
      checkThreadOwnerArgs(threadId, owner, org);
      const ins = await pool.query<Raw>(
        `INSERT INTO ${s}.fg_thread_owners (thread_id, owner, org, created_at) VALUES ($1, $2, $3, $4)
          ON CONFLICT (thread_id) DO NOTHING RETURNING thread_id, owner, org, created_at`,
        [threadId, owner, org, now],
      );
      if (ins.rows[0]) return { ...rec(ins.rows[0]), created: true };
      // The conflicting row is committed (ON CONFLICT waited for it), so a plain read sees it.
      const r = await pool.query<Raw>(select, [threadId]);
      return { ...rec(r.rows[0]!), created: false };
    },
    async get(threadId) {
      checkThreadOwnerArgs(threadId);
      const r = await pool.query<Raw>(select, [threadId]);
      return r.rows[0] ? rec(r.rows[0]) : undefined;
    },
  };
}
