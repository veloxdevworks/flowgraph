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
  ThreadRunGuard,
  selectRetainedCheckpointIds,
  threadDeletionRequested,
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
    const latest = 2;
    if (current > latest) {
      throw new Error(
        `postgres schema ${schema}: checkpoint schema version ${current} is newer than this flowgraph supports (${latest}); upgrade flowgraph`,
      );
    }
    let applied = 0;
    if (current < 1) {
      await client.query(`
        CREATE TABLE ${s}.fg_checkpoint_threads (
          thread_id  TEXT PRIMARY KEY,
          status     TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished')),
          updated_at BIGINT NOT NULL,
          deletable  INTEGER NOT NULL DEFAULT 0,
          finished_ttl_ms BIGINT,
          max_finished INTEGER
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
      applied += 1;
    }
    if (current < 2) {
      await client.query(`ALTER TABLE ${s}.fg_checkpoint_threads ADD COLUMN IF NOT EXISTS deletable INTEGER NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE ${s}.fg_checkpoint_threads ADD COLUMN IF NOT EXISTS finished_ttl_ms BIGINT`);
      await client.query(`ALTER TABLE ${s}.fg_checkpoint_threads ADD COLUMN IF NOT EXISTS max_finished INTEGER`);
      await client.query(
        `INSERT INTO ${s}.fg_schema_migrations (component, version, applied_at) VALUES ('checkpoint', 2, $1)`,
        [Date.now()],
      );
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

interface IdRow {
  checkpoint_id: string;
}
interface ThreadRow {
  thread_id: string;
  status: string;
  updated_at: string | number;
  finished_ttl_ms: string | number | null;
  max_finished: string | number | null;
  deletable: number;
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
  private readonly threadPolicy = new Map<string, ResolvedCheckpointRetention>();
  private readonly runs = new ThreadRunGuard();
  private lastSweepAt = 0;

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
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== "string") return result;
    const policy = this.policyFor(threadId);
    if (!policy.enabled) return result;
    const ns = config.configurable?.checkpoint_ns ?? "";
    if (threadDeletionRequested(policy)) await this.touch(threadId, "active", Date.now(), policy);
    const deleted = await this.pruneNamespace(threadId, ns, policy);
    const droppedWrites = await this.compactWrites(threadId, ns);
    await this.maybeVacuum(deleted + droppedWrites, policy);
    return result;
  }

  override async putWrites(
    config: Parameters<PostgresSaver["putWrites"]>[0],
    writes: Parameters<PostgresSaver["putWrites"]>[1],
    taskId: Parameters<PostgresSaver["putWrites"]>[2],
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    const threadIdEarly = config.configurable?.thread_id;
    if (typeof threadIdEarly === "string" && !this.policyFor(threadIdEarly).enabled) return;
    const channel = writes.find(([name]) => CHECKPOINT_PIN_CHANNELS.has(String(name)))?.[0];
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (channel === undefined || typeof threadId !== "string" || typeof checkpointId !== "string") return;
    await this.addPin(threadId, config.configurable?.checkpoint_ns ?? "", checkpointId, String(channel), Date.now());
  }

  override async deleteThread(threadId: string): Promise<void> {
    if (this.runs.held(threadId)) return;
    const counted = await this.db().query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${this.q}.checkpoints WHERE thread_id = $1`,
      [threadId],
    );
    await super.deleteThread(threadId);
    const pool = this.db();
    await pool.query(`DELETE FROM ${this.q}.fg_checkpoint_pins WHERE thread_id = $1`, [threadId]);
    await pool.query(`DELETE FROM ${this.q}.fg_checkpoint_threads WHERE thread_id = $1`, [threadId]);
    await pool.query(`DELETE FROM ${this.q}.fg_memory_threads WHERE thread_id = $1`).catch((err: { code?: string }) => {
      if (err.code !== "42P01") throw err;
    });
    // fg_thread_owners and fg_memory_ops are left in place. Ownership outlives
    // the checkpoints, and memory replay records belong to the memory sweeper.
    await this.maybeVacuum(Number(counted.rows[0]?.n ?? 0), this.retention);
  }

  noteThreadPolicy(threadId: string, policy: ResolvedCheckpointRetention): void {
    this.threadPolicy.set(threadId, policy);
  }

  beginThreadRun(threadId: string): void {
    this.runs.begin(threadId);
  }

  endThreadRun(threadId: string, status: CheckpointThreadStatus): void {
    this.runs.end(threadId, status);
  }

  async noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now = Date.now()): Promise<void> {
    const policy = this.policyFor(threadId);
    if (!policy.enabled) return;
    if (status === "paused") await this.pinHead(threadId, now);
    if (!threadDeletionRequested(policy)) return;
    await this.touch(threadId, status, now, policy);
    if (status !== "finished") return;
    const cap = policy.maxFinishedThreads;
    let overCap = false;
    if (cap !== null && cap > 0) {
      const counted = await this.db().query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ${this.q}.fg_checkpoint_threads
         WHERE deletable = 1 AND status = 'finished' AND max_finished IS NOT NULL`,
      );
      overCap = Number(counted.rows[0]?.n ?? 0) > cap;
    }
    if (cap === 0 || overCap || now - this.lastSweepAt >= 60_000) {
      this.lastSweepAt = now;
      await this.sweep(now);
    }
  }

  async sweep(now = Date.now()): Promise<void> {
    this.lastSweepAt = now;
    const aged = await this.db().query<ThreadRow>(
      `SELECT thread_id, status, updated_at, finished_ttl_ms, max_finished, deletable
       FROM ${this.q}.fg_checkpoint_threads
       WHERE deletable = 1 AND status = 'finished' AND finished_ttl_ms IS NOT NULL`,
    );
    for (const row of aged.rows) {
      const ttl = Number(row.finished_ttl_ms);
      if (!Number.isFinite(ttl) || now - Number(row.updated_at) < ttl) continue;
      await this.deleteThread(row.thread_id);
    }
    const capped = await this.db().query<ThreadRow>(
      `SELECT thread_id, status, updated_at, finished_ttl_ms, max_finished, deletable
       FROM ${this.q}.fg_checkpoint_threads
       WHERE deletable = 1 AND status = 'finished' AND max_finished IS NOT NULL
       ORDER BY max_finished ASC, updated_at ASC, thread_id ASC`,
    );
    const groups = new Map<number, ThreadRow[]>();
    for (const row of capped.rows) {
      const cap = Number(row.max_finished);
      const list = groups.get(cap) ?? [];
      list.push(row);
      groups.set(cap, list);
    }
    for (const [cap, rows] of groups) {
      if (rows.length <= cap) continue;
      let removed = 0;
      const need = rows.length - cap;
      for (const row of rows) {
        if (removed >= need) break;
        if (this.runs.held(row.thread_id)) continue;
        await this.deleteThread(row.thread_id);
        removed += 1;
      }
    }
    if (this.retention.vacuum === "always") await this.maybeVacuum(1, { ...this.retention, vacuum: "always" });
  }

  /** Blocking VACUUM only when the policy asks for `always`. `auto` does not lock the tables. */
  private async maybeVacuum(deleted: number, policy: ResolvedCheckpointRetention): Promise<void> {
    if (!policy.enabled || policy.vacuum !== "always" || deleted <= 0) return;
    for (const table of ["checkpoints", "checkpoint_blobs", "checkpoint_writes", "fg_checkpoint_threads"]) {
      await this.db().query(`VACUUM ${this.q}.${table}`);
    }
  }

  /**
   * Drop pending writes only after a child checkpoint row exists.
   * Writes stored under an id that is not inserted yet belong to a queued put.
   */
  private async compactWrites(threadId: string, ns: string): Promise<number> {
    const result = await this.db().query(
      `DELETE FROM ${this.q}.checkpoint_writes w
       WHERE w.thread_id = $1 AND w.checkpoint_ns = $2
         AND EXISTS (
           SELECT 1 FROM ${this.q}.checkpoints child
           WHERE child.thread_id = w.thread_id
             AND child.checkpoint_ns = w.checkpoint_ns
             AND child.parent_checkpoint_id = w.checkpoint_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${this.q}.fg_checkpoint_pins p
           WHERE p.thread_id = w.thread_id
             AND p.checkpoint_ns = w.checkpoint_ns
             AND p.checkpoint_id = w.checkpoint_id
         )`,
      [threadId, ns],
    );
    return result.rowCount ?? 0;
  }

  private policyFor(threadId: string): ResolvedCheckpointRetention {
    return this.threadPolicy.get(threadId) ?? this.retention;
  }

  private async touch(
    threadId: string,
    status: CheckpointThreadStatus,
    now: number,
    policy: ResolvedCheckpointRetention,
  ): Promise<void> {
    const deletable = status === "finished" && threadDeletionRequested(policy) ? 1 : 0;
    await this.db().query(
      `INSERT INTO ${this.q}.fg_checkpoint_threads
         (thread_id, status, updated_at, deletable, finished_ttl_ms, max_finished)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (thread_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         deletable = EXCLUDED.deletable,
         finished_ttl_ms = EXCLUDED.finished_ttl_ms,
         max_finished = EXCLUDED.max_finished`,
      [threadId, status, now, deletable, deletable ? policy.finishedTtlMs : null, deletable ? policy.maxFinishedThreads : null],
    );
  }

  private async addPin(
    threadId: string,
    ns: string,
    checkpointId: string,
    reason: string,
    now: number,
  ): Promise<void> {
    const cap = this.policyFor(threadId).maxInterruptPoints;
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

  private async pruneNamespace(threadId: string, ns: string, policy: ResolvedCheckpointRetention): Promise<number> {
    const client = await this.db().connect();
    try {
      await client.query("BEGIN");
      const listed = await client.query<IdRow & { parent_checkpoint_id: string | null }>(
        `SELECT checkpoint_id, parent_checkpoint_id FROM ${this.q}.checkpoints
         WHERE thread_id = $1 AND checkpoint_ns = $2
         ORDER BY checkpoint_id DESC`,
        [threadId, ns],
      );
      const ids = listed.rows.map((row) => row.checkpoint_id);
      if (ids.length === 0) {
        await client.query("COMMIT");
        return 0;
      }
      const interrupts = await client.query<IdRow>(
        `SELECT DISTINCT checkpoint_id FROM ${this.q}.checkpoint_writes
         WHERE thread_id = $1 AND checkpoint_ns = $2 AND channel = ANY($3::text[])`,
        [threadId, ns, PIN_LIST],
      );
      const pins = await client.query<IdRow>(
        `SELECT checkpoint_id FROM ${this.q}.fg_checkpoint_pins
         WHERE thread_id = $1 AND checkpoint_ns = $2
         ORDER BY pinned_at DESC`,
        [threadId, ns],
      );
      const parentOf = new Map(listed.rows.map((row) => [row.checkpoint_id, row.parent_checkpoint_id]));
      const keep = selectRetainedCheckpointIds({
        idsNewestFirst: ids,
        parentOf,
        maxCheckpoints: policy.maxCheckpoints,
        interruptIds: interrupts.rows.map((row) => row.checkpoint_id),
        explicitPinsNewestFirst: pins.rows.map((row) => row.checkpoint_id),
        maxInterruptPoints: policy.maxInterruptPoints,
      });
      const drop = ids.filter((id) => !keep.has(id));
      if (drop.length === 0) {
        await client.query("COMMIT");
        return 0;
      }
      // Only ids this transaction listed and chose to drop. NOT IN (keep)
      // also deletes writes for a checkpoint LangGraph has not stored yet.
      for (let i = 0; i < drop.length; i += 500) {
        const chunk = drop.slice(i, i + 500);
        await client.query(
          `DELETE FROM ${this.q}.checkpoints
           WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = ANY($3::text[])`,
          [threadId, ns, chunk],
        );
        await client.query(
          `DELETE FROM ${this.q}.checkpoint_writes
           WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = ANY($3::text[])`,
          [threadId, ns, chunk],
        );
        await client.query(
          `DELETE FROM ${this.q}.fg_checkpoint_pins
           WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = ANY($3::text[])`,
          [threadId, ns, chunk],
        );
      }
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
      return drop.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
