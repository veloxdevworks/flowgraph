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
  selectRetainedCheckpointIds,
  threadDeletionRequested,
  type CheckpointThreadStatus,
  type ResolvedCheckpointRetention,
} from "@flowgraph/core";

/** Serde type stock SqliteSaver rejects. Channel values live in fg_checkpoint_blobs. */
export const FG_CHECKPOINT_TYPE = "fg-checkpoint-v1";
import type { SqliteDatabase } from "./memory.js";

const PIN_LIST = [...CHECKPOINT_PIN_CHANNELS];

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

function asRows<T>(rows: unknown[]): T[] {
  return rows as T[];
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
  private schemaReady = false;
  private lastSweepAt = 0;

  constructor(db: SqliteDatabase, retention: ResolvedCheckpointRetention) {
    super(db as never);
    this.sqlite = db;
    this.retention = retention;
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
      if (threadDeletionRequested(policy)) this.touch(threadId, "active", Date.now(), policy);
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
    this.addPin(threadId, config.configurable?.checkpoint_ns ?? "", checkpointId, String(channel), Date.now());
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.setup();
    const deleted = this.deleteThreadSync(threadId);
    this.maybeVacuum(deleted, this.retention);
  }

  noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now = Date.now()): void {
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

  sweep(now = Date.now()): void {
    this.setup();
    this.lastSweepAt = now;
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
      deleted += this.deleteThreadSync(row.thread_id);
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
      for (const row of rows.slice(0, rows.length - cap)) deleted += this.deleteThreadSync(row.thread_id);
    }
    this.maybeVacuum(deleted, this.retention);
  }

  private policyFor(threadId: string): ResolvedCheckpointRetention {
    return this.threadPolicy.get(threadId) ?? this.retention;
  }

  private touch(threadId: string, status: CheckpointThreadStatus, now: number, policy: ResolvedCheckpointRetention): void {
    const deletable = status === "finished" && threadDeletionRequested(policy) ? 1 : 0;
    const ttl = deletable ? policy.finishedTtlMs : null;
    const cap = deletable ? policy.maxFinishedThreads : null;
    this.sqlite
      .prepare(
        `INSERT INTO fg_checkpoint_threads
           (thread_id, status, updated_at, deletable, finished_ttl_ms, max_finished)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at,
           deletable = excluded.deletable,
           finished_ttl_ms = excluded.finished_ttl_ms,
           max_finished = excluded.max_finished`,
      )
      .run(threadId, status, now, deletable, ttl, cap);
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
    const n = Number(
      asRow<{ n: number }>(this.sqlite.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?`).get(threadId))
        ?.n ?? 0,
    );
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(threadId);
      this.sqlite.prepare(`DELETE FROM writes WHERE thread_id = ?`).run(threadId);
      this.sqlite.prepare(`DELETE FROM fg_checkpoint_blobs WHERE thread_id = ?`).run(threadId);
      this.sqlite.prepare(`DELETE FROM fg_checkpoint_pins WHERE thread_id = ?`).run(threadId);
      this.sqlite.prepare(`DELETE FROM fg_checkpoint_threads WHERE thread_id = ?`).run(threadId);
      const memoryThreads = this.sqlite
        .prepare(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'fg_memory_threads'`)
        .get();
      if (memoryThreads) this.sqlite.prepare(`DELETE FROM fg_memory_threads WHERE thread_id = ?`).run(threadId);
    })();
    return n;
  }

  /**
   * Pending writes are only required on a branch tip (nothing has superseded
   * them) and on interrupt/resume pins. Drop the rest.
   */
  private compactWrites(threadId: string, ns: string): number {
    const result = this.sqlite
      .prepare(
        `DELETE FROM writes
         WHERE thread_id = ? AND checkpoint_ns = ?
           AND checkpoint_id NOT IN (
             SELECT c.checkpoint_id FROM checkpoints c
             WHERE c.thread_id = ? AND c.checkpoint_ns = ?
               AND NOT EXISTS (
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
    const rows = asRows<CpRow & { parent_checkpoint_id: string | null }>(
      this.sqlite
        .prepare(
          `SELECT checkpoint_id, parent_checkpoint_id, type, checkpoint FROM checkpoints
           WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC`,
        )
        .all(threadId, ns),
    );
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.checkpoint_id);
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
    const parentOf = new Map(rows.map((row) => [row.checkpoint_id, row.parent_checkpoint_id]));
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ids,
      parentOf,
      maxCheckpoints: policy.maxCheckpoints,
      interruptIds,
      explicitPinsNewestFirst: explicit,
      maxInterruptPoints: policy.maxInterruptPoints,
    });
    if (keep.size === ids.length) return 0;

    const referenced = new Set<string>();
    for (const row of rows) {
      if (!keep.has(row.checkpoint_id)) continue;
      const checkpoint = (await this.serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint;
      for (const [channel, version] of Object.entries(checkpoint.channel_versions ?? {})) {
        referenced.add(`${channel}\0${String(version)}`);
      }
    }
    const blobs = asRows<BlobRow>(
      this.sqlite
        .prepare(`SELECT channel, version FROM fg_checkpoint_blobs WHERE thread_id = ? AND checkpoint_ns = ?`)
        .all(threadId, ns),
    );
    const dropBlobs = blobs.filter((blob) => !referenced.has(`${blob.channel}\0${blob.version}`));
    const keepIds = [...keep];
    this.sqlite.transaction(() => {
      const marks = keepIds.map(() => "?").join(", ");
      this.sqlite
        .prepare(
          `DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (${marks})`,
        )
        .run(threadId, ns, ...keepIds);
      this.sqlite
        .prepare(`DELETE FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (${marks})`)
        .run(threadId, ns, ...keepIds);
      this.sqlite
        .prepare(
          `DELETE FROM fg_checkpoint_pins WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (${marks})`,
        )
        .run(threadId, ns, ...keepIds);
      const dropBlob = this.sqlite.prepare(
        `DELETE FROM fg_checkpoint_blobs
         WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND version = ?`,
      );
      for (const blob of dropBlobs) dropBlob.run(threadId, ns, blob.channel, blob.version);
    })();
    return ids.length - keep.size;
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
