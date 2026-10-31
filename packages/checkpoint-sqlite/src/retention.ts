/**
 * SQLite checkpoint retention.
 *
 * The LangGraph saver stores a full checkpoint blob and every pending write
 * forever. This subclass keeps that on-disk format readable, stores each
 * channel version once in `fg_checkpoint_blobs`, and deletes checkpoints that
 * fall outside the retention window. `fg_memory_*` tables are never touched.
 */

import { copyCheckpoint, type Checkpoint, type CheckpointTuple } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  CHECKPOINT_INLINE_MAX_BYTES,
  CHECKPOINT_PIN_CHANNELS,
  ThreadRunGuard,
  abandonedActivePolicy,
  abandonedFallbackCutoff,
  selectRetainedCheckpointIds,
  threadDeletionRequested,
  type ActiveThreadMark,
  type CheckpointThreadStatus,
  type ResolvedCheckpointRetention,
} from "@flowgraph/core";

/** Serde type stock SqliteSaver rejects. Channel values live in fg_checkpoint_blobs. */
export const FG_CHECKPOINT_TYPE = "fg-checkpoint-v1";
import type { SqliteDatabase } from "./memory.js";

const PIN_LIST = [...CHECKPOINT_PIN_CHANNELS];
/** Stay under SQLite's bound-parameter limit and avoid one giant delete. */
const PRUNE_PAGE = 80;

const MIGRATION_V1 = `
CREATE TABLE fg_checkpoint_blobs (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
) WITHOUT ROWID;
CREATE TABLE fg_checkpoint_threads (
  thread_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished')),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX fg_checkpoint_threads_finished
  ON fg_checkpoint_threads (updated_at) WHERE status = 'finished';
CREATE TABLE fg_checkpoint_pins (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
) WITHOUT ROWID;
`;

const MIGRATION_V2 = `
ALTER TABLE fg_checkpoint_threads ADD COLUMN deletable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fg_checkpoint_threads ADD COLUMN finished_ttl_ms INTEGER;
ALTER TABLE fg_checkpoint_threads ADD COLUMN max_finished INTEGER;
`;

const MIGRATION_V3 = `
ALTER TABLE fg_checkpoint_threads ADD COLUMN active_mark TEXT;
`;

/**
 * Active rows record the policy a sweep applies if their run is abandoned:
 * `active_ttl_ms` (0 = never), and the finished TTL and cap in the existing
 * columns. NULL marks a row stamped before this column existed. The partial
 * index keeps the sweep's scan of active rows off finished and paused ones.
 */
const MIGRATION_V4 = `
ALTER TABLE fg_checkpoint_threads ADD COLUMN active_ttl_ms INTEGER;
CREATE INDEX IF NOT EXISTS fg_checkpoint_threads_active
  ON fg_checkpoint_threads (updated_at) WHERE status = 'active';
`;

interface IdRow {
  checkpoint_id: string;
}
interface CpRow {
  checkpoint_id: string;
  type: string | null;
  checkpoint: Uint8Array;
}
interface BlobRow {
  channel: string;
  version: string;
}
interface ThreadRow {
  thread_id: string;
  status: string;
  updated_at: number;
  finished_ttl_ms: number | null;
  max_finished: number | null;
  deletable: number;
}
interface ActiveRow {
  thread_id: string;
  updated_at: number;
  active_mark: string | null;
  active_ttl_ms: number | null;
  finished_ttl_ms: number | null;
  max_finished: number | null;
}

export interface FlowgraphSqliteSaverOptions {
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  clock?: () => number;
}

function asRows<T>(rows: unknown[]): T[] {
  return rows as T[];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function asRow<T>(row: unknown): T | undefined {
  return row as T | undefined;
}

/** Forward-only migrations for component "checkpoint". Does not touch memory tables. */
export function migrateSqliteCheckpointRetention(db: SqliteDatabase): number {
  db.exec(`CREATE TABLE IF NOT EXISTS fg_schema_migrations (
    component TEXT NOT NULL,
    version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (component, version)
  ) WITHOUT ROWID`);
  const apply = db.transaction(() => {
    const current =
      asRow<{ v: number | null }>(
        db.prepare(`SELECT MAX(version) AS v FROM fg_schema_migrations WHERE component = 'checkpoint'`).get(),
      )?.v ?? 0;
    const steps = [
      { version: 1, sql: MIGRATION_V1 },
      { version: 2, sql: MIGRATION_V2 },
      { version: 3, sql: MIGRATION_V3 },
      { version: 4, sql: MIGRATION_V4 },
    ];
    const latest = steps[steps.length - 1]?.version ?? 0;
    if (current > latest) {
      throw new Error(
        `${db.name}: checkpoint schema version ${current} is newer than this flowgraph supports (${latest}); upgrade flowgraph`,
      );
    }
    let applied = 0;
    for (const step of steps) {
      if (step.version <= current) continue;
      db.exec(step.sql);
      db.prepare(`INSERT INTO fg_schema_migrations (component, version, applied_at) VALUES ('checkpoint', ?, ?)`).run(
        step.version,
        Date.now(),
      );
      applied += 1;
    }
    return applied;
  });
  return apply.immediate();
}

export interface SqliteCheckpointStats {
  checkpoints: number;
  writes: number;
  blobs: number;
  checkpointBytes: number;
  writeBytes: number;
  blobBytes: number;
}

export function sqliteCheckpointStats(db: SqliteDatabase): SqliteCheckpointStats {
  const one = (table: string, bytesSql: string): { n: number; b: number } => {
    const exists = db.prepare(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    if (!exists) return { n: 0, b: 0 };
    const row = asRow<{ n: number; b: number }>(
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${bytesSql}), 0) AS b FROM ${table}`).get(),
    );
    return { n: Number(row?.n ?? 0), b: Number(row?.b ?? 0) };
  };
  const checkpoints = one("checkpoints", "COALESCE(length(checkpoint), 0) + COALESCE(length(metadata), 0)");
  const writes = one("writes", "COALESCE(length(value), 0)");
  const blobs = one("fg_checkpoint_blobs", "COALESCE(length(value), 0)");
  return {
    checkpoints: checkpoints.n,
    writes: writes.n,
    blobs: blobs.n,
    checkpointBytes: checkpoints.b,
    writeBytes: writes.b,
    blobBytes: blobs.b,
  };
}

/**
 * SqliteSaver that prunes each thread to the retention window and stores
 * channel values once per version.
 */
export class FlowgraphSqliteSaver extends SqliteSaver {
  readonly retention: ResolvedCheckpointRetention;
  private readonly sqlite: SqliteDatabase;
  private readonly threadPolicy = new Map<string, ResolvedCheckpointRetention>();
  private readonly runs = new ThreadRunGuard();
  private schemaReady = false;
  private lastSweepAt = 0;
  private readonly clock: () => number;

  constructor(db: SqliteDatabase, retention: ResolvedCheckpointRetention, options?: FlowgraphSqliteSaverOptions) {
    super(db as never);
    this.sqlite = db;
    this.retention = retention;
    this.clock = options?.clock ?? Date.now;
    const inner = this.serde;
    // Stock SqliteSaver rejects this type. Our reads treat it as json and
    // fill channel values from fg_checkpoint_blobs, whatever the current flags are.
    this.serde = {
      dumpsTyped: (value: unknown) => inner.dumpsTyped(value),
      loadsTyped: (type: string, data: Uint8Array | string) =>
        inner.loadsTyped(type === FG_CHECKPOINT_TYPE ? "json" : type, data),
    };
  }

  /** Create retention tables, seal deduped rows, and sweep opted-in threads. */
  prepare(): void {
    this.setup();
    this.sealDedupeRows();
    this.sweep();
  }

  protected override setup(): void {
    if (!this.schemaReady) this.enableIncrementalVacuum();
    super.setup();
    if (this.schemaReady) return;
    migrateSqliteCheckpointRetention(this.sqlite);
    this.schemaReady = true;
  }

  noteThreadPolicy(threadId: string, policy: ResolvedCheckpointRetention): void {
    this.threadPolicy.set(threadId, policy);
  }

  markThreadActive(threadId: string): ActiveThreadMark | undefined {
    const policy = this.policyFor(threadId);
    if (!policy.enabled || !threadDeletionRequested(policy)) return undefined;
    this.setup();
    const mark = crypto.randomUUID();
    const markedAt = this.clock();
    const prior = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(`SELECT status, updated_at FROM fg_checkpoint_threads WHERE thread_id = ?`)
        .get(threadId) as { status: CheckpointThreadStatus; updated_at: number } | undefined;
      this.touch(threadId, "active", markedAt, policy, mark);
      if (!row) return undefined;
      return { status: row.status, updatedAt: Number(row.updated_at) };
    }).immediate();
    return { mark, prior, markedAt };
  }

  savedThreadStatus(threadId: string): { status: CheckpointThreadStatus; updatedAt: number } | undefined {
    this.setup();
    const row = this.sqlite
      .prepare(`SELECT status, updated_at FROM fg_checkpoint_threads WHERE thread_id = ?`)
      .get(threadId) as { status: CheckpointThreadStatus; updated_at: number } | undefined;
    if (!row) return undefined;
    return { status: row.status, updatedAt: Number(row.updated_at) };
  }

  restoreThreadStatus(
    threadId: string,
    prior: { status: CheckpointThreadStatus; updatedAt: number } | undefined,
    activeMark: string,
    markedAt?: number,
  ): void {
    this.setup();
    if (prior?.status === "active") return;
    // A row written since the mark carries a newer timestamp and stays.
    const at = markedAt ?? null;
    if (!prior) {
      this.sqlite
        .prepare(
          `DELETE FROM fg_checkpoint_threads
           WHERE thread_id = ? AND status = 'active' AND active_mark = ? AND (? IS NULL OR updated_at = ?)`,
        )
        .run(threadId, activeMark, at, at);
      return;
    }
    const policy = this.policyFor(threadId);
    const deletable = prior.status === "finished" && threadDeletionRequested(policy) ? 1 : 0;
    this.sqlite
      .prepare(
        `UPDATE fg_checkpoint_threads
         SET status = ?, updated_at = ?, deletable = ?, finished_ttl_ms = ?, max_finished = ?,
             active_mark = NULL, active_ttl_ms = NULL
         WHERE thread_id = ? AND status = 'active' AND active_mark = ? AND (? IS NULL OR updated_at = ?)`,
      )
      .run(
        prior.status,
        prior.updatedAt,
        deletable,
        deletable ? policy.finishedTtlMs : null,
        deletable ? policy.maxFinishedThreads : null,
        threadId,
        activeMark,
        at,
        at,
      );
  }

  noteThreadWaiting(threadId: string, activeMark: string): boolean {
    this.setup();
    const now = this.clock();
    const result = this.sqlite
      .prepare(
        `UPDATE fg_checkpoint_threads
         SET status = 'paused', updated_at = ?, deletable = 0, finished_ttl_ms = NULL, max_finished = NULL,
             active_ttl_ms = NULL
         WHERE thread_id = ? AND status = 'active' AND active_mark = ?`,
      )
      .run(now, threadId, activeMark);
    if (result.changes === 0) return false;
    this.pinHead(threadId, now);
    return true;
  }

  noteThreadAnswered(threadId: string, activeMark: string): boolean {
    this.setup();
    const policy = this.policyFor(threadId);
    const result = this.sqlite
      .prepare(
        `UPDATE fg_checkpoint_threads
         SET status = 'active', updated_at = ?, deletable = 0, finished_ttl_ms = ?, max_finished = ?,
             active_ttl_ms = ?
         WHERE thread_id = ? AND status = 'paused' AND active_mark = ?`,
      )
      .run(this.clock(), policy.finishedTtlMs, policy.maxFinishedThreads, policy.activeTtlMs ?? 0, threadId, activeMark);
    return result.changes > 0;
  }

  beginThreadRun(threadId: string): number {
    return this.runs.begin(threadId);
  }

  endThreadRun(threadId: string, status: CheckpointThreadStatus, token = 0, resumed = false, releaseOnly = false): void {
    this.runs.end(threadId, status, token, resumed, releaseOnly);
  }

  override async getTuple(config: Parameters<SqliteSaver["getTuple"]>[0]): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(config);
    if (tuple) await this.rehydrate(tuple);
    return tuple;
  }

  override async *list(
    config: Parameters<SqliteSaver["list"]>[0],
    options?: Parameters<SqliteSaver["list"]>[1],
  ): AsyncGenerator<CheckpointTuple> {
    for await (const tuple of super.list(config, options)) {
      await this.rehydrate(tuple);
      yield tuple;
    }
  }

  override async put(
    config: Parameters<SqliteSaver["put"]>[0],
    checkpoint: Parameters<SqliteSaver["put"]>[1],
    metadata: Parameters<SqliteSaver["put"]>[2],
    newVersions?: Record<string, string | number>,
  ): Promise<Parameters<SqliteSaver["put"]>[0]> {
    void newVersions;
    const threadId = config.configurable?.thread_id;
    const ns = config.configurable?.checkpoint_ns ?? "";
    const policy = typeof threadId === "string" ? this.policyFor(threadId) : this.retention;
    let stored = checkpoint;
    let deduped = false;
    if (policy.enabled && typeof threadId === "string" && threadDeletionRequested(policy)) {
      this.setup();
      // Each checkpoint is activity. The run's mark stays so a restore still matches it.
      this.touch(threadId, "active", this.clock(), policy, null, true);
    }
    if (policy.enabled && policy.dedupeChannels && typeof threadId === "string") {
      this.setup();
      stored = copyCheckpoint(checkpoint);
      const parentId = config.configurable?.checkpoint_id;
      deduped = await this.writeBlobs(threadId, ns, stored, typeof parentId === "string" ? parentId : undefined);
    }
    const result = await super.put(config, stored, metadata);
    if (deduped && typeof threadId === "string") {
      this.sqlite
        .prepare(
          `UPDATE checkpoints SET type = ? WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        )
        .run(FG_CHECKPOINT_TYPE, threadId, ns, checkpoint.id);
    }
    if (policy.enabled && typeof threadId === "string") {
      const deleted = await this.pruneNamespace(threadId, ns, policy);
      const droppedWrites = this.compactWrites(threadId, ns);
      this.maybeVacuum(deleted + droppedWrites, policy);
    }
    return result;
  }

  override async putWrites(
    config: Parameters<SqliteSaver["putWrites"]>[0],
    writes: Parameters<SqliteSaver["putWrites"]>[1],
    taskId: Parameters<SqliteSaver["putWrites"]>[2],
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    const threadIdEarly = config.configurable?.thread_id;
    if (typeof threadIdEarly === "string" && !this.policyFor(threadIdEarly).enabled) return;
    const channel = writes.find(([name]) => CHECKPOINT_PIN_CHANNELS.has(String(name)))?.[0];
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (channel === undefined || typeof threadId !== "string" || typeof checkpointId !== "string") return;
    this.addPin(threadId, config.configurable?.checkpoint_ns ?? "", checkpointId, String(channel), this.clock());
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.setup();
    const deleted = this.deleteThreadSync(threadId);
    this.maybeVacuum(deleted, this.retention);
  }

  noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now = this.clock()): void {
    const policy = this.policyFor(threadId);
    if (!policy.enabled) return;
    this.setup();
    if (status === "paused") this.pinHead(threadId, now);
    if (!threadDeletionRequested(policy)) return;
    this.touch(threadId, status, now, policy);
    if (status !== "finished") return;
    const cap = policy.maxFinishedThreads;
    const overCap = cap !== null && this.finishedOverCap(cap);
    if (cap === 0 || overCap || now - this.lastSweepAt >= 60_000) {
      this.lastSweepAt = now;
      this.sweep(now);
    }
  }

  private finishedOverCap(cap: number): boolean {
    const n = asRow<{ n: number }>(
      this.sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM fg_checkpoint_threads
           WHERE deletable = 1 AND status = 'finished' AND max_finished IS NOT NULL`,
        )
        .get(),
    );
    return Number(n?.n ?? 0) > cap;
  }

  sweep(now = this.clock()): void {
    this.setup();
    this.lastSweepAt = now;
    this.reclaimAbandoned(now);
    let deleted = 0;
    const aged = asRows<ThreadRow>(
      this.sqlite
        .prepare(
          `SELECT thread_id, status, updated_at, finished_ttl_ms, max_finished, deletable
           FROM fg_checkpoint_threads
           WHERE deletable = 1 AND status = 'finished' AND finished_ttl_ms IS NOT NULL`,
        )
        .all(),
    );
    for (const row of aged) {
      const ttl = Number(row.finished_ttl_ms);
      if (!Number.isFinite(ttl) || now - row.updated_at < ttl) continue;
      deleted += this.deleteFinishedIfUnchanged(row.thread_id, Number(row.updated_at));
    }
    const capped = asRows<ThreadRow>(
      this.sqlite
        .prepare(
          `SELECT thread_id, status, updated_at, finished_ttl_ms, max_finished, deletable
           FROM fg_checkpoint_threads
           WHERE deletable = 1 AND status = 'finished' AND max_finished IS NOT NULL
           ORDER BY max_finished ASC, updated_at ASC, thread_id ASC`,
        )
        .all(),
    );
    const groups = new Map<number, ThreadRow[]>();
    for (const row of capped) {
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
        deleted += this.deleteFinishedIfUnchanged(row.thread_id, Number(row.updated_at));
        removed += 1;
      }
    }
    this.maybeVacuum(deleted, this.retention);
  }

  /**
   * An active row with no activity for its `activeTtl` belongs to a run that
   * stopped without recording a status. Turn it into a finished row as of its
   * last activity so the finished-thread rules apply. The update matches the
   * row as listed (status, timestamp, mark), so a run that marked or
   * checkpointed in between keeps it. Threads this process holds are skipped.
   */
  private reclaimAbandoned(now: number): void {
    const rows = asRows<ActiveRow>(
      this.sqlite
        .prepare(
          `SELECT thread_id, updated_at, active_mark, active_ttl_ms, finished_ttl_ms, max_finished
           FROM fg_checkpoint_threads
           WHERE status = 'active'
             AND ((active_ttl_ms > 0 AND updated_at <= ? - active_ttl_ms)
               OR (active_ttl_ms IS NULL AND updated_at <= ?))`,
        )
        .all(now, abandonedFallbackCutoff(this.retention, now)),
    );
    const reclaim = this.sqlite.prepare(
      `UPDATE fg_checkpoint_threads
       SET status = 'finished', deletable = 1, finished_ttl_ms = ?, max_finished = ?,
           active_mark = NULL, active_ttl_ms = NULL
       WHERE thread_id = ? AND status = 'active' AND updated_at = ? AND active_mark IS ?`,
    );
    for (const row of rows) {
      const policy = abandonedActivePolicy({
        updatedAt: Number(row.updated_at),
        now,
        held: this.runs.held(row.thread_id),
        recorded:
          row.active_ttl_ms === null
            ? undefined
            : {
                activeTtlMs: Number(row.active_ttl_ms),
                finishedTtlMs: row.finished_ttl_ms === null ? null : Number(row.finished_ttl_ms),
                maxFinishedThreads: row.max_finished === null ? null : Number(row.max_finished),
              },
        fallback: this.retention,
      });
      if (!policy) continue;
      reclaim.run(policy.finishedTtlMs, policy.maxFinishedThreads, row.thread_id, row.updated_at, row.active_mark);
    }
  }

  private policyFor(threadId: string): ResolvedCheckpointRetention {
    return this.threadPolicy.get(threadId) ?? this.retention;
  }

  private touch(
    threadId: string,
    status: CheckpointThreadStatus,
    now: number,
    policy: ResolvedCheckpointRetention,
    activeMark: string | null = null,
    keepActiveMark = false,
  ): void {
    const deletable = status === "finished" && threadDeletionRequested(policy) ? 1 : 0;
    // An active row carries the policy a sweep applies if its run is abandoned.
    const active = status === "active";
    const ttl = deletable || active ? policy.finishedTtlMs : null;
    const cap = deletable || active ? policy.maxFinishedThreads : null;
    const activeTtl = active ? (policy.activeTtlMs ?? 0) : null;
    this.sqlite
      .prepare(
        `INSERT INTO fg_checkpoint_threads
           (thread_id, status, updated_at, deletable, finished_ttl_ms, max_finished, active_mark, active_ttl_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at,
           deletable = excluded.deletable,
           finished_ttl_ms = excluded.finished_ttl_ms,
           max_finished = excluded.max_finished,
           active_mark = CASE
             WHEN ? = 1 AND fg_checkpoint_threads.status = 'active' THEN fg_checkpoint_threads.active_mark
             ELSE excluded.active_mark
           END,
           active_ttl_ms = excluded.active_ttl_ms`,
      )
      .run(threadId, status, now, deletable, ttl, cap, activeMark, activeTtl, keepActiveMark ? 1 : 0);
  }

  private addPin(threadId: string, ns: string, checkpointId: string, reason: string, now: number): void {
    const cap = this.policyFor(threadId).maxInterruptPoints;
    if (cap <= 0) return;
    this.sqlite
      .prepare(
        `INSERT INTO fg_checkpoint_pins (thread_id, checkpoint_ns, checkpoint_id, reason, pinned_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
         DO UPDATE SET reason = excluded.reason, pinned_at = excluded.pinned_at`,
      )
      .run(threadId, ns, checkpointId, reason, now);
    this.sqlite
      .prepare(
        `DELETE FROM fg_checkpoint_pins
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (
           SELECT checkpoint_id FROM fg_checkpoint_pins
           WHERE thread_id = ? AND checkpoint_ns = ?
           ORDER BY pinned_at DESC
           LIMIT ?
         )`,
      )
      .run(threadId, ns, threadId, ns, cap);
  }

  private pinHead(threadId: string, now: number): void {
    const heads = asRows<{ checkpoint_ns: string; checkpoint_id: string }>(
      this.sqlite
        .prepare(
          `SELECT checkpoint_ns, MAX(checkpoint_id) AS checkpoint_id
           FROM checkpoints WHERE thread_id = ? GROUP BY checkpoint_ns`,
        )
        .all(threadId),
    );
    for (const head of heads) this.addPin(threadId, head.checkpoint_ns, head.checkpoint_id, "paused", now);
  }

  private deleteThreadSync(threadId: string): number {
    return this.sqlite.transaction(() => this.eraseThread(threadId))();
  }

  /**
   * Sweep path. Deletes only when the thread is still the finished row the
   * sweep listed, in one write transaction, so a run that marked it active
   * is left alone. An explicit {@link deleteThread} does not use this.
   */
  private deleteFinishedIfUnchanged(threadId: string, updatedAt: number): number {
    if (this.runs.held(threadId)) return 0;
    return this.sqlite.transaction(() => {
      const row = asRow<{ status: string; updated_at: number; deletable: number }>(
        this.sqlite
          .prepare(`SELECT status, updated_at, deletable FROM fg_checkpoint_threads WHERE thread_id = ?`)
          .get(threadId),
      );
      if (!row || row.status !== "finished" || Number(row.deletable) !== 1 || Number(row.updated_at) !== updatedAt) {
        return 0;
      }
      return this.eraseThread(threadId);
    }).immediate();
  }

  private eraseThread(threadId: string): number {
    const n = Number(
      asRow<{ n: number }>(this.sqlite.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?`).get(threadId))
        ?.n ?? 0,
    );
    this.sqlite.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(threadId);
    this.sqlite.prepare(`DELETE FROM writes WHERE thread_id = ?`).run(threadId);
    this.sqlite.prepare(`DELETE FROM fg_checkpoint_blobs WHERE thread_id = ?`).run(threadId);
    this.sqlite.prepare(`DELETE FROM fg_checkpoint_pins WHERE thread_id = ?`).run(threadId);
    this.sqlite.prepare(`DELETE FROM fg_checkpoint_threads WHERE thread_id = ?`).run(threadId);
    // The scope binding is only meaningful while this thread's checkpoints
    // exist. Thread ownership and memory replay records are not checkpoint
    // history: fg_thread_owners stays so another caller cannot claim the id,
    // and fg_memory_ops stays for the memory sweeper.
    const memoryThreads = this.sqlite
      .prepare(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'fg_memory_threads'`)
      .get();
    if (memoryThreads) this.sqlite.prepare(`DELETE FROM fg_memory_threads WHERE thread_id = ?`).run(threadId);
    return n;
  }

  /**
   * Pending writes are required on a branch tip and on interrupt/resume pins.
   * Drop them only once a successor row is stored. Writes for a checkpoint id
   * that is not inserted yet belong to a put that is still queued.
   */
  private compactWrites(threadId: string, ns: string): number {
    const result = this.sqlite
      .prepare(
        `DELETE FROM writes
         WHERE thread_id = ? AND checkpoint_ns = ?
           AND checkpoint_id IN (
             SELECT c.checkpoint_id FROM checkpoints c
             WHERE c.thread_id = ? AND c.checkpoint_ns = ?
               AND EXISTS (
                 SELECT 1 FROM checkpoints child
                 WHERE child.thread_id = c.thread_id
                   AND child.checkpoint_ns = c.checkpoint_ns
                   AND child.parent_checkpoint_id = c.checkpoint_id
               )
           )
           AND checkpoint_id NOT IN (
             SELECT checkpoint_id FROM fg_checkpoint_pins
             WHERE thread_id = ? AND checkpoint_ns = ?
           )`,
      )
      .run(threadId, ns, threadId, ns, threadId, ns);
    return result.changes;
  }

  /**
   * Leave small and one-off values in the checkpoint row. A value larger than
   * {@link CHECKPOINT_INLINE_MAX_BYTES} is copied to `fg_checkpoint_blobs` only
   * when this version was already stored, and then omitted from this row.
   * Returns true when the stored checkpoint no longer contains every value.
   */
  private async writeBlobs(threadId: string, ns: string, checkpoint: Checkpoint, parentId: string | undefined): Promise<boolean> {
    const values = checkpoint.channel_values ?? {};
    const versions = checkpoint.channel_versions ?? {};
    const parentVersions = parentId ? await this.parentChannelVersions(threadId, ns, parentId) : undefined;
    const insert = this.sqlite.prepare(
      `INSERT OR IGNORE INTO fg_checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, value)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const hasBlob = this.sqlite.prepare(
      `SELECT 1 AS n FROM fg_checkpoint_blobs
       WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND version = ?`,
    );
    let omitted = false;
    for (const channel of Object.keys(values)) {
      const version = versions[channel];
      if (version === undefined) continue;
      const verKey = String(version);
      const [type, bytes] = await this.serde.dumpsTyped(values[channel]);
      if (bytes.byteLength <= CHECKPOINT_INLINE_MAX_BYTES) continue;
      const already = hasBlob.get(threadId, ns, channel, verKey);
      const repeated = parentVersions !== undefined && String(parentVersions[channel]) === verKey;
      if (!already && !repeated) continue;
      if (!already) insert.run(threadId, ns, channel, verKey, type, Buffer.from(bytes));
      delete checkpoint.channel_values[channel];
      omitted = true;
    }
    return omitted;
  }

  private async parentChannelVersions(
    threadId: string,
    ns: string,
    parentId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const row = asRow<{ type: string | null; checkpoint: Uint8Array }>(
      this.sqlite
        .prepare(
          `SELECT type, checkpoint FROM checkpoints
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        )
        .get(threadId, ns, parentId),
    );
    if (!row) return undefined;
    try {
      const checkpoint = (await this.serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint;
      return checkpoint.channel_versions ?? {};
    } catch {
      return undefined;
    }
  }

  private async rehydrate(tuple: CheckpointTuple): Promise<void> {
    const threadId = tuple.config.configurable?.thread_id;
    const ns = tuple.config.configurable?.checkpoint_ns ?? "";
    const checkpointId = tuple.checkpoint.id;
    if (typeof threadId !== "string") return;
    const storedType = asRow<{ type: string | null }>(
      this.sqlite
        .prepare(
          `SELECT type FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        )
        .get(threadId, ns, checkpointId),
    )?.type;
    const deduped = storedType === FG_CHECKPOINT_TYPE;
    const checkpoint = tuple.checkpoint;
    checkpoint.channel_values ??= {};
    const versions = checkpoint.channel_versions ?? {};
    const select = this.sqlite.prepare(
      `SELECT type, value FROM fg_checkpoint_blobs
       WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND version = ?`,
    );
    let filled = 0;
    for (const channel of Object.keys(versions)) {
      if (Object.prototype.hasOwnProperty.call(checkpoint.channel_values, channel) && checkpoint.channel_values[channel] !== undefined) {
        continue;
      }
      const version = versions[channel];
      if (version === undefined) continue;
      const row = asRow<{ type: string | null; value: Uint8Array | null }>(
        select.get(threadId, ns, channel, String(version)),
      );
      if (!row?.type || row.value == null) continue;
      checkpoint.channel_values[channel] = await this.serde.loadsTyped(row.type, row.value);
      filled += 1;
    }
    if (deduped && filled === 0 && Object.keys(versions).length > 0) {
      const anyBlob = this.sqlite
        .prepare(`SELECT 1 AS n FROM fg_checkpoint_blobs WHERE thread_id = ? AND checkpoint_ns = ? LIMIT 1`)
        .get(threadId, ns);
      if (anyBlob) {
        throw new Error(
          `flowgraph: checkpoint "${checkpointId}" for thread "${threadId}" is in the deduped format but its channel blobs could not be read. Refusing to return empty state.`,
        );
      }
    }
  }

  private async pruneNamespace(
    threadId: string,
    ns: string,
    policy: ResolvedCheckpointRetention,
  ): Promise<number> {
    const listed = this.listCheckpointIds(threadId, ns);
    if (listed.length === 0) return 0;
    const ids = listed.map((row) => row.checkpoint_id);
    const interruptIds = asRows<IdRow>(
      this.sqlite
        .prepare(
          `SELECT DISTINCT checkpoint_id FROM writes
           WHERE thread_id = ? AND checkpoint_ns = ? AND channel IN (${PIN_LIST.map(() => "?").join(", ")})`,
        )
        .all(threadId, ns, ...PIN_LIST),
    ).map((row) => row.checkpoint_id);
    const explicit = asRows<IdRow>(
      this.sqlite
        .prepare(
          `SELECT checkpoint_id FROM fg_checkpoint_pins
           WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY pinned_at DESC`,
        )
        .all(threadId, ns),
    ).map((row) => row.checkpoint_id);
    const parentOf = new Map(listed.map((row) => [row.checkpoint_id, row.parent_checkpoint_id]));
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ids,
      parentOf,
      maxCheckpoints: policy.maxCheckpoints,
      interruptIds,
      explicitPinsNewestFirst: explicit,
      maxInterruptPoints: policy.maxInterruptPoints,
    });
    const drop = ids.filter((id) => !keep.has(id));
    if (drop.length === 0) return 0;

    const referenced = await this.referencedBlobKeys(threadId, ns, [...keep]);
    this.sqlite.transaction(() => {
      for (const chunk of chunks(drop, PRUNE_PAGE)) {
        const marks = chunk.map(() => "?").join(", ");
        this.sqlite
          .prepare(`DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (${marks})`)
          .run(threadId, ns, ...chunk);
        // Only ids we listed and chose to drop. A NOT IN (keep) would also
        // delete writes LangGraph stored for a checkpoint that is not inserted yet.
        this.sqlite
          .prepare(`DELETE FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (${marks})`)
          .run(threadId, ns, ...chunk);
        this.sqlite
          .prepare(
            `DELETE FROM fg_checkpoint_pins WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (${marks})`,
          )
          .run(threadId, ns, ...chunk);
      }
      this.deleteUnreferencedBlobs(threadId, ns, referenced);
    })();
    return drop.length;
  }

  /** Checkpoint ids newest-first, without loading checkpoint blobs. */
  private listCheckpointIds(
    threadId: string,
    ns: string,
  ): Array<{ checkpoint_id: string; parent_checkpoint_id: string | null }> {
    const listed: Array<{ checkpoint_id: string; parent_checkpoint_id: string | null }> = [];
    let cursor: string | null = null;
    const first = this.sqlite.prepare(
      `SELECT checkpoint_id, parent_checkpoint_id FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ?
       ORDER BY checkpoint_id DESC LIMIT ?`,
    );
    const next = this.sqlite.prepare(
      `SELECT checkpoint_id, parent_checkpoint_id FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id < ?
       ORDER BY checkpoint_id DESC LIMIT ?`,
    );
    for (;;) {
      const rows: Array<{ checkpoint_id: string; parent_checkpoint_id: string | null }> = asRows(
        cursor === null ? first.all(threadId, ns, PRUNE_PAGE) : next.all(threadId, ns, cursor, PRUNE_PAGE),
      );
      listed.push(...rows);
      const last = rows[rows.length - 1];
      if (!last || rows.length < PRUNE_PAGE) break;
      cursor = last.checkpoint_id;
    }
    return listed;
  }

  /** Channel versions still referenced by checkpoints we are keeping. */
  private async referencedBlobKeys(threadId: string, ns: string, keepIds: string[]): Promise<Set<string>> {
    const referenced = new Set<string>();
    const load = (marks: string) =>
      this.sqlite.prepare(
        `SELECT type, checkpoint FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (${marks})`,
      );
    for (const chunk of chunks(keepIds, PRUNE_PAGE)) {
      const rows = asRows<Pick<CpRow, "type" | "checkpoint">>(
        load(chunk.map(() => "?").join(", ")).all(threadId, ns, ...chunk),
      );
      for (const row of rows) {
        const checkpoint = (await this.serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint;
        for (const [channel, version] of Object.entries(checkpoint.channel_versions ?? {})) {
          referenced.add(`${channel}\0${String(version)}`);
        }
      }
    }
    return referenced;
  }

  /** Page blob keys and delete the ones no kept checkpoint references. */
  private deleteUnreferencedBlobs(threadId: string, ns: string, referenced: Set<string>): void {
    const first = this.sqlite.prepare(
      `SELECT channel, version FROM fg_checkpoint_blobs
       WHERE thread_id = ? AND checkpoint_ns = ?
       ORDER BY channel, version LIMIT ?`,
    );
    const next = this.sqlite.prepare(
      `SELECT channel, version FROM fg_checkpoint_blobs
       WHERE thread_id = ? AND checkpoint_ns = ?
         AND (channel > ? OR (channel = ? AND version > ?))
       ORDER BY channel, version LIMIT ?`,
    );
    const drop = this.sqlite.prepare(
      `DELETE FROM fg_checkpoint_blobs
       WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND version = ?`,
    );
    let cursor: BlobRow | null = null;
    for (;;) {
      const rows: BlobRow[] = asRows(
        cursor === null
          ? first.all(threadId, ns, PRUNE_PAGE)
          : next.all(threadId, ns, cursor.channel, cursor.channel, cursor.version, PRUNE_PAGE),
      );
      for (const blob of rows) {
        if (!referenced.has(`${blob.channel}\0${blob.version}`)) drop.run(threadId, ns, blob.channel, blob.version);
      }
      const last = rows[rows.length - 1];
      if (!last || rows.length < PRUNE_PAGE) break;
      cursor = last;
    }
  }

  private maybeVacuum(deleted: number, policy: ResolvedCheckpointRetention): void {
    if (!policy.enabled || policy.vacuum === "never" || deleted <= 0) return;
    if (policy.vacuum === "auto") {
      try {
        // No argument reclaims every free page. A no-op unless auto_vacuum is INCREMENTAL.
        this.sqlite.pragma("incremental_vacuum");
      } catch {
        /* auto_vacuum is not INCREMENTAL on this file */
      }
      return;
    }
    try {
      this.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      this.sqlite.exec("VACUUM");
    } catch {
      // VACUUM fails if a statement is still open. A later prune retries.
    }
  }

  /** New files can reclaim pages without a blocking VACUUM. Existing files are left alone. */
  private enableIncrementalVacuum(): void {
    const n = asRow<{ n: number }>(
      this.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .get(),
    );
    if ((n?.n ?? 0) > 0) return;
    try {
      this.sqlite.pragma("auto_vacuum = INCREMENTAL");
    } catch {
      /* file already has a schema */
    }
  }

  /**
   * Rows written before the dedupe type was stamped look like empty json to a
   * stock saver. Stamp them so that saver throws instead of returning empty state.
   */
  private sealDedupeRows(): void {
    const rows = asRows<{ thread_id: string; checkpoint_ns: string; checkpoint_id: string; checkpoint: Uint8Array }>(
      this.sqlite
        .prepare(
          `SELECT thread_id, checkpoint_ns, checkpoint_id, checkpoint FROM checkpoints
           WHERE type IS NULL OR type = 'json'`,
        )
        .all(),
    );
    const stamp = this.sqlite.prepare(
      `UPDATE checkpoints SET type = ? WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
    );
    const hasBlob = this.sqlite.prepare(
      `SELECT 1 AS n FROM fg_checkpoint_blobs WHERE thread_id = ? AND checkpoint_ns = ? LIMIT 1`,
    );
    for (const row of rows) {
      if (!hasBlob.get(row.thread_id, row.checkpoint_ns)) continue;
      let empty = false;
      try {
        const text = Buffer.isBuffer(row.checkpoint)
          ? row.checkpoint.toString("utf8")
          : new TextDecoder().decode(row.checkpoint);
        const parsed = JSON.parse(text) as { channel_values?: Record<string, unknown> };
        empty = !parsed.channel_values || Object.keys(parsed.channel_values).length === 0;
      } catch {
        empty = false;
      }
      if (empty) stamp.run(FG_CHECKPOINT_TYPE, row.thread_id, row.checkpoint_ns, row.checkpoint_id);
    }
  }
}
