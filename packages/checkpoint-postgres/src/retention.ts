/**
 * Postgres checkpoint retention.
 *
 * Channel values already live in `checkpoint_blobs`, one row per version.
 * Nothing deletes old versions, old writes, or finished threads. This subclass
 * keeps the newest checkpoints per thread namespace, keeps interrupt and
 * resume points, and deletes blobs no remaining checkpoint references.
 * `fg_memory_*` tables are never touched.
 */

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type pg from "pg";
import {
  CHECKPOINT_PIN_CHANNELS,
  selectRetainedCheckpointIds,
  type CheckpointThreadStatus,
  type ResolvedCheckpointRetention,
} from "@flowgraph/core";
import { quoteSchema } from "./memory.js";

const PIN_LIST = [...CHECKPOINT_PIN_CHANNELS];

/**
 * Forward-only migrations for component "checkpoint", under a transaction
 * advisory lock so concurrent hosts apply each version once. Separate from
 * the memory migrations and from LangGraph's own checkpoint_migrations.
 */
export async function migratePostgresCheckpointRetention(pool: pg.Pool, schema: string): Promise<number> {
  const s = quoteSchema(schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `flowgraph:checkpoint:migrate:${schema}`,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.fg_schema_migrations (
      component  TEXT    NOT NULL,
      version    INTEGER NOT NULL,
      applied_at BIGINT  NOT NULL,
      PRIMARY KEY (component, version)
    )`);
    const currentRow = await client.query<{ v: number | null }>(
      `SELECT MAX(version) AS v FROM ${s}.fg_schema_migrations WHERE component = 'checkpoint'`,
    );
    const current = currentRow.rows[0]?.v ?? 0;
    const latest = 1;
    if (current > latest) {
      throw new Error(
        `postgres schema ${schema}: checkpoint schema version ${current} is newer than this flowgraph supports (${latest}); upgrade flowgraph`,
      );
    }
    if (current >= latest) {
      await client.query("COMMIT");
      return 0;
    }
    await client.query(`
      CREATE TABLE ${s}.fg_checkpoint_threads (
        thread_id  TEXT PRIMARY KEY,
        status     TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished')),
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX fg_checkpoint_threads_finished
        ON ${s}.fg_checkpoint_threads (updated_at) WHERE status = 'finished';
      CREATE TABLE ${s}.fg_checkpoint_pins (
        thread_id     TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        reason        TEXT NOT NULL,
        pinned_at     BIGINT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
    `);
    await client.query(
      `INSERT INTO ${s}.fg_schema_migrations (component, version, applied_at) VALUES ('checkpoint', 1, $1)`,
      [Date.now()],
    );
    await client.query("COMMIT");
    return 1;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface IdRow {
  checkpoint_id: string;
}
interface ThreadRow {
  thread_id: string;
  status: string;
  updated_at: string | number;
}

/**
 * PostgresSaver that prunes checkpoints and unreferenced channel blobs.
 * The pool field on the parent is private, so retention reaches it through
 * the instance that `super` already stored.
 */
export class FlowgraphPostgresSaver extends PostgresSaver {
  readonly retention: ResolvedCheckpointRetention;
  private readonly schemaName: string;
  private readonly q: string;
  /** Checkpoint rows deleted since the last VACUUM. */
  private deletedSinceVacuum = 0;

  constructor(pool: pg.Pool, retention: ResolvedCheckpointRetention, options?: { schema?: string }) {
    const schema = options?.schema ?? "public";
    super(pool, undefined, { schema });
    this.schemaName = schema;
    this.retention = retention;
    this.q = quoteSchema(schema);
  }

  private db(): pg.Pool {
    return (this as unknown as { pool: pg.Pool }).pool;
  }

  override async setup(): Promise<void> {
    await super.setup();
    await migratePostgresCheckpointRetention(this.db(), this.schemaName);
    await this.sweep();
  }

  override async put(
    config: Parameters<PostgresSaver["put"]>[0],
    checkpoint: Parameters<PostgresSaver["put"]>[1],
    metadata: Parameters<PostgresSaver["put"]>[2],
    newVersions: Parameters<PostgresSaver["put"]>[3],
  ): Promise<Awaited<ReturnType<PostgresSaver["put"]>>> {
    const result = await super.put(config, checkpoint, metadata, newVersions);
    if (!this.retention.enabled) return result;
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== "string") return result;
    const ns = config.configurable?.checkpoint_ns ?? "";
    await this.touch(threadId, "active", Date.now());
    await this.maybeVacuum(await this.pruneNamespace(threadId, ns));
    return result;
  }

  override async putWrites(
    config: Parameters<PostgresSaver["putWrites"]>[0],
    writes: Parameters<PostgresSaver["putWrites"]>[1],
    taskId: Parameters<PostgresSaver["putWrites"]>[2],
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    if (!this.retention.enabled) return;
    const channel = writes.find(([name]) => CHECKPOINT_PIN_CHANNELS.has(String(name)))?.[0];
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (channel === undefined || typeof threadId !== "string" || typeof checkpointId !== "string") return;
    await this.addPin(threadId, config.configurable?.checkpoint_ns ?? "", checkpointId, String(channel), Date.now());
  }

  override async deleteThread(threadId: string): Promise<void> {
    const counted = await this.db().query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${this.q}.checkpoints WHERE thread_id = $1`,
      [threadId],
    );
    await super.deleteThread(threadId);
    const pool = this.db();
    await pool.query(`DELETE FROM ${this.q}.fg_checkpoint_pins WHERE thread_id = $1`, [threadId]);
    await pool.query(`DELETE FROM ${this.q}.fg_checkpoint_threads WHERE thread_id = $1`, [threadId]);
    await this.maybeVacuum(Number(counted.rows[0]?.n ?? 0));
  }

  async noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now = Date.now()): Promise<void> {
    if (!this.retention.enabled) return;
    if (status === "paused") await this.pinHead(threadId, now);
    await this.touch(threadId, status, now);
    if (status === "finished") await this.sweep(now);
  }

  async sweep(now = Date.now()): Promise<void> {
    if (!this.retention.enabled) return;
    const ttl = this.retention.finishedTtlMs;
    if (ttl !== null) {
      const cutoff = now - ttl;
      const stale = await this.db().query<ThreadRow>(
        `SELECT thread_id, status, updated_at FROM ${this.q}.fg_checkpoint_threads
         WHERE status <> 'paused' AND updated_at < $1`,
        [cutoff],
      );
      for (const row of stale.rows) {
        if (row.status === "active" && (await this.headIsPinned(row.thread_id))) {
          await this.touch(row.thread_id, "paused", Number(row.updated_at));
          continue;
        }
        await this.deleteThread(row.thread_id);
      }
      await this.sweepUntracked(cutoff);
    }
    const cap = this.retention.maxFinishedThreads;
    if (cap !== null) {
      const extra = await this.db().query<{ thread_id: string }>(
        `SELECT thread_id FROM ${this.q}.fg_checkpoint_threads
         WHERE status = 'finished'
         ORDER BY updated_at DESC, thread_id DESC
         OFFSET $1`,
        [cap],
      );
      for (const row of extra.rows) await this.deleteThread(row.thread_id);
    }
    if (this.retention.vacuum === "always") await this.maybeVacuum(100);
  }

  /** Reclaim dead rows once enough checkpoints have been deleted. `always` does not wait. */
  private async maybeVacuum(deleted: number): Promise<void> {
    if (!this.retention.enabled || this.retention.vacuum === "never" || deleted <= 0) return;
    this.deletedSinceVacuum += deleted;
    if (this.retention.vacuum !== "always" && this.deletedSinceVacuum < 100) return;
    this.deletedSinceVacuum = 0;
    for (const table of ["checkpoints", "checkpoint_blobs", "checkpoint_writes", "fg_checkpoint_threads"]) {
      await this.db().query(`VACUUM ${this.q}.${table}`);
    }
  }

  private async touch(threadId: string, status: CheckpointThreadStatus, now: number): Promise<void> {
    await this.db().query(
      `INSERT INTO ${this.q}.fg_checkpoint_threads (thread_id, status, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (thread_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [threadId, status, now],
    );
  }

  private async addPin(
    threadId: string,
    ns: string,
    checkpointId: string,
    reason: string,
    now: number,
  ): Promise<void> {
    const cap = this.retention.maxInterruptPoints;
    if (cap <= 0) return;
    await this.db().query(
      `INSERT INTO ${this.q}.fg_checkpoint_pins (thread_id, checkpoint_ns, checkpoint_id, reason, pinned_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
       DO UPDATE SET reason = EXCLUDED.reason, pinned_at = EXCLUDED.pinned_at`,
      [threadId, ns, checkpointId, reason, now],
    );
    await this.db().query(
      `DELETE FROM ${this.q}.fg_checkpoint_pins p
       WHERE p.thread_id = $1 AND p.checkpoint_ns = $2
         AND p.checkpoint_id NOT IN (
           SELECT checkpoint_id FROM ${this.q}.fg_checkpoint_pins
           WHERE thread_id = $1 AND checkpoint_ns = $2
           ORDER BY pinned_at DESC
           LIMIT $3
         )`,
      [threadId, ns, cap],
    );
  }

  private async pinHead(threadId: string, now: number): Promise<void> {
    const heads = await this.db().query<{ checkpoint_ns: string; checkpoint_id: string }>(
      `SELECT DISTINCT ON (checkpoint_ns) checkpoint_ns, checkpoint_id
       FROM ${this.q}.checkpoints
       WHERE thread_id = $1
       ORDER BY checkpoint_ns, checkpoint_id DESC`,
      [threadId],
    );
    for (const head of heads.rows) await this.addPin(threadId, head.checkpoint_ns, head.checkpoint_id, "paused", now);
  }

  private async headIsPinned(threadId: string): Promise<boolean> {
    const found = await this.db().query(
      `SELECT 1
       FROM ${this.q}.checkpoints c
       WHERE c.thread_id = $1
         AND c.checkpoint_id = (
           SELECT MAX(checkpoint_id) FROM ${this.q}.checkpoints
           WHERE thread_id = c.thread_id AND checkpoint_ns = c.checkpoint_ns
         )
         AND (
           EXISTS (
             SELECT 1 FROM ${this.q}.checkpoint_writes w
             WHERE w.thread_id = c.thread_id AND w.checkpoint_ns = c.checkpoint_ns
               AND w.checkpoint_id = c.checkpoint_id AND w.channel = ANY($2::text[])
           )
           OR EXISTS (
             SELECT 1 FROM ${this.q}.fg_checkpoint_pins p
             WHERE p.thread_id = c.thread_id AND p.checkpoint_ns = c.checkpoint_ns
               AND p.checkpoint_id = c.checkpoint_id
           )
         )
       LIMIT 1`,
      [threadId, PIN_LIST],
    );
    return (found.rowCount ?? 0) > 0;
  }

  private async sweepUntracked(cutoff: number): Promise<void> {
    const threads = await this.db().query<{ thread_id: string; ts: string | null }>(
      `SELECT c.thread_id, c.checkpoint ->> 'ts' AS ts
       FROM ${this.q}.checkpoints c
       WHERE c.checkpoint_id = (
         SELECT MAX(checkpoint_id) FROM ${this.q}.checkpoints WHERE thread_id = c.thread_id
       )
         AND NOT EXISTS (
           SELECT 1 FROM ${this.q}.fg_checkpoint_threads t WHERE t.thread_id = c.thread_id
         )`,
      [],
    );
    for (const row of threads.rows) {
      if (await this.headIsPinned(row.thread_id)) {
        await this.touch(row.thread_id, "paused", cutoff);
        continue;
      }
      const ts = row.ts ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(ts) || ts >= cutoff) continue;
      await this.deleteThread(row.thread_id);
    }
  }

  private async pruneNamespace(threadId: string, ns: string): Promise<number> {
    const pool = this.db();
    const listed = await pool.query<IdRow>(
      `SELECT checkpoint_id FROM ${this.q}.checkpoints
       WHERE thread_id = $1 AND checkpoint_ns = $2
       ORDER BY checkpoint_id DESC`,
      [threadId, ns],
    );
    const ids = listed.rows.map((row) => row.checkpoint_id);
    if (ids.length === 0) return 0;
    const interrupts = await pool.query<IdRow>(
      `SELECT DISTINCT checkpoint_id FROM ${this.q}.checkpoint_writes
       WHERE thread_id = $1 AND checkpoint_ns = $2 AND channel = ANY($3::text[])`,
      [threadId, ns, PIN_LIST],
    );
    const pins = await pool.query<IdRow>(
      `SELECT checkpoint_id FROM ${this.q}.fg_checkpoint_pins
       WHERE thread_id = $1 AND checkpoint_ns = $2
       ORDER BY pinned_at DESC`,
      [threadId, ns],
    );
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ids,
      maxCheckpoints: this.retention.maxCheckpoints,
      interruptIds: interrupts.rows.map((row) => row.checkpoint_id),
      explicitPinsNewestFirst: pins.rows.map((row) => row.checkpoint_id),
      maxInterruptPoints: this.retention.maxInterruptPoints,
    });
    if (keep.size === ids.length) return 0;
    const keepIds = [...keep];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM ${this.q}.checkpoints
         WHERE thread_id = $1 AND checkpoint_ns = $2 AND NOT (checkpoint_id = ANY($3::text[]))`,
        [threadId, ns, keepIds],
      );
      await client.query(
        `DELETE FROM ${this.q}.checkpoint_writes
         WHERE thread_id = $1 AND checkpoint_ns = $2 AND NOT (checkpoint_id = ANY($3::text[]))`,
        [threadId, ns, keepIds],
      );
      await client.query(
        `DELETE FROM ${this.q}.fg_checkpoint_pins
         WHERE thread_id = $1 AND checkpoint_ns = $2 AND NOT (checkpoint_id = ANY($3::text[]))`,
        [threadId, ns, keepIds],
      );
      await client.query(
        `DELETE FROM ${this.q}.checkpoint_blobs b
         WHERE b.thread_id = $1 AND b.checkpoint_ns = $2
           AND NOT EXISTS (
             SELECT 1 FROM ${this.q}.checkpoints c
             WHERE c.thread_id = b.thread_id
               AND c.checkpoint_ns = b.checkpoint_ns
               AND (c.checkpoint -> 'channel_versions' ->> b.channel) = b.version
           )`,
        [threadId, ns],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return ids.length - keep.size;
  }
}
