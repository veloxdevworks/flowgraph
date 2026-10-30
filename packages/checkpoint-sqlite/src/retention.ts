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
  CHECKPOINT_PIN_CHANNELS,
  selectRetainedCheckpointIds,
  type CheckpointThreadStatus,
  type ResolvedCheckpointRetention,
} from "@flowgraph/core";
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
    const latest = 1;
    if (current > latest) {
      throw new Error(
        `${db.name}: checkpoint schema version ${current} is newer than this flowgraph supports (${latest}); upgrade flowgraph`,
      );
    }
    if (current >= latest) return 0;
    db.exec(MIGRATION_V1);
    db.prepare(`INSERT INTO fg_schema_migrations (component, version, applied_at) VALUES ('checkpoint', 1, ?)`).run(
      Date.now(),
    );
    return 1;
  });
  return apply.immediate();
}

function checkpointTimestamp(row: { type: string | null; checkpoint: Uint8Array }): number | null {
  if (row.type && row.type !== "json") return null;
  try {
    const text = Buffer.isBuffer(row.checkpoint) ? row.checkpoint.toString("utf8") : new TextDecoder().decode(row.checkpoint);
    const parsed = JSON.parse(text) as { ts?: unknown };
    if (typeof parsed.ts !== "string") return null;
    const ms = Date.parse(parsed.ts);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
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
  private schemaReady = false;

  constructor(db: SqliteDatabase, retention: ResolvedCheckpointRetention) {
    super(db as never);
    this.sqlite = db;
    this.retention = retention;
  }

  /** Create retention tables and sweep finished threads. Safe to call more than once. */
  prepare(): void {
    this.setup();
    this.sweep();
  }

  protected override setup(): void {
    super.setup();
    if (this.schemaReady) return;
    migrateSqliteCheckpointRetention(this.sqlite);
    this.schemaReady = true;
  }

  override async getTuple(config: Parameters<SqliteSaver["getTuple"]>[0]): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(config);
    if (tuple && this.retention.enabled && this.retention.dedupeChannels) await this.rehydrate(tuple);
    return tuple;
  }

  override async *list(
    config: Parameters<SqliteSaver["list"]>[0],
    options?: Parameters<SqliteSaver["list"]>[1],
  ): AsyncGenerator<CheckpointTuple> {
    for await (const tuple of super.list(config, options)) {
      if (this.retention.enabled && this.retention.dedupeChannels) await this.rehydrate(tuple);
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
    let stored = checkpoint;
    if (this.retention.enabled && this.retention.dedupeChannels && typeof threadId === "string") {
      this.setup();
      stored = copyCheckpoint(checkpoint);
      await this.writeBlobs(threadId, ns, checkpoint);
      stored.channel_values = {};
    }
    const result = await super.put(config, stored, metadata);
    if (this.retention.enabled && typeof threadId === "string") {
      this.touch(threadId, "active", Date.now());
      const deleted = await this.pruneNamespace(threadId, ns);
      this.maybeVacuum(deleted);
    }
    return result;
  }

  override async putWrites(
    config: Parameters<SqliteSaver["putWrites"]>[0],
    writes: Parameters<SqliteSaver["putWrites"]>[1],
    taskId: Parameters<SqliteSaver["putWrites"]>[2],
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    if (!this.retention.enabled) return;
    const channel = writes.find(([name]) => CHECKPOINT_PIN_CHANNELS.has(String(name)))?.[0];
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (channel === undefined || typeof threadId !== "string" || typeof checkpointId !== "string") return;
    this.addPin(threadId, config.configurable?.checkpoint_ns ?? "", checkpointId, String(channel), Date.now());
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.setup();
    const deleted = this.deleteThreadSync(threadId);
    this.maybeVacuum(deleted);
  }

  noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now = Date.now()): void {
    if (!this.retention.enabled) return;
    this.setup();
    if (status === "paused") this.pinHead(threadId, now);
    this.touch(threadId, status, now);
    if (status === "finished") this.sweep(now);
  }

  sweep(now = Date.now()): void {
    if (!this.retention.enabled) return;
    this.setup();
    let deleted = 0;
    const ttl = this.retention.finishedTtlMs;
    if (ttl !== null) {
      const cutoff = now - ttl;
      const rows = asRows<ThreadRow>(
        this.sqlite
          .prepare(
            `SELECT thread_id, status, updated_at FROM fg_checkpoint_threads WHERE status != 'paused' AND updated_at < ?`,
          )
          .all(cutoff),
      );
      for (const row of rows) {
        if (row.status === "active" && this.headIsPinned(row.thread_id)) {
          this.sqlite.prepare(`UPDATE fg_checkpoint_threads SET status = 'paused' WHERE thread_id = ?`).run(row.thread_id);
          continue;
        }
        deleted += this.deleteThreadSync(row.thread_id);
      }
      deleted += this.sweepUntracked(cutoff);
    }
    const cap = this.retention.maxFinishedThreads;
    if (cap !== null) {
      const extra = asRows<IdRow>(
        this.sqlite
          .prepare(
            `SELECT thread_id AS checkpoint_id FROM fg_checkpoint_threads
             WHERE status = 'finished'
             ORDER BY updated_at DESC, thread_id DESC
             LIMIT -1 OFFSET ?`,
          )
          .all(cap),
      );
      for (const row of extra) deleted += this.deleteThreadSync(row.checkpoint_id);
    }
    this.maybeVacuum(deleted);
  }

  private touch(threadId: string, status: CheckpointThreadStatus, now: number): void {
    this.sqlite
      .prepare(
        `INSERT INTO fg_checkpoint_threads (thread_id, status, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(threadId, status, now);
  }

  private addPin(threadId: string, ns: string, checkpointId: string, reason: string, now: number): void {
    const cap = this.retention.maxInterruptPoints;
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

  private headIsPinned(threadId: string): boolean {
    const heads = asRows<{ checkpoint_ns: string; checkpoint_id: string }>(
      this.sqlite
        .prepare(
          `SELECT checkpoint_ns, MAX(checkpoint_id) AS checkpoint_id
           FROM checkpoints WHERE thread_id = ? GROUP BY checkpoint_ns`,
        )
        .all(threadId),
    );
    for (const head of heads) {
      const write = this.sqlite
        .prepare(
          `SELECT 1 AS n FROM writes
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel IN ('__interrupt__', '__resume__', '__error__')
           LIMIT 1`,
        )
        .get(threadId, head.checkpoint_ns, head.checkpoint_id);
      if (write) return true;
      const pin = this.sqlite
        .prepare(
          `SELECT 1 AS n FROM fg_checkpoint_pins WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        )
        .get(threadId, head.checkpoint_ns, head.checkpoint_id);
      if (pin) return true;
    }
    return false;
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
    })();
    return n;
  }

  private sweepUntracked(cutoff: number): number {
    const threads = asRows<{ thread_id: string }>(
      this.sqlite
        .prepare(
          `SELECT DISTINCT thread_id FROM checkpoints
           WHERE thread_id NOT IN (SELECT thread_id FROM fg_checkpoint_threads)`,
        )
        .all(),
    );
    let deleted = 0;
    for (const { thread_id: threadId } of threads) {
      if (this.headIsPinned(threadId)) {
        this.touch(threadId, "paused", cutoff);
        continue;
      }
      const head = asRow<{ type: string | null; checkpoint: Uint8Array }>(
        this.sqlite
          .prepare(
            `SELECT type, checkpoint FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT 1`,
          )
          .get(threadId),
      );
      const ts = head ? checkpointTimestamp(head) : null;
      if (ts === null || ts >= cutoff) continue;
      deleted += this.deleteThreadSync(threadId);
    }
    return deleted;
  }

  private async writeBlobs(threadId: string, ns: string, checkpoint: Checkpoint): Promise<void> {
    const values = checkpoint.channel_values ?? {};
    const versions = checkpoint.channel_versions ?? {};
    const insert = this.sqlite.prepare(
      `INSERT OR IGNORE INTO fg_checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, value)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const channel of Object.keys(values)) {
      const version = versions[channel];
      if (version === undefined) continue;
      const verKey = String(version);
      const existing = this.sqlite
        .prepare(
          `SELECT 1 AS n FROM fg_checkpoint_blobs
           WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND version = ?`,
        )
        .get(threadId, ns, channel, verKey);
      if (existing) continue;
      const [type, bytes] = await this.serde.dumpsTyped(values[channel]);
      insert.run(threadId, ns, channel, verKey, type, Buffer.from(bytes));
    }
  }

  private async rehydrate(tuple: CheckpointTuple): Promise<void> {
    const threadId = tuple.config.configurable?.thread_id;
    const ns = tuple.config.configurable?.checkpoint_ns ?? "";
    if (typeof threadId !== "string") return;
    const checkpoint = tuple.checkpoint;
    checkpoint.channel_values ??= {};
    const versions = checkpoint.channel_versions ?? {};
    const select = this.sqlite.prepare(
      `SELECT type, value FROM fg_checkpoint_blobs
       WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND version = ?`,
    );
    for (const channel of Object.keys(versions)) {
      if (Object.prototype.hasOwnProperty.call(checkpoint.channel_values, channel)) continue;
      const version = versions[channel];
      if (version === undefined) continue;
      const row = asRow<{ type: string | null; value: Uint8Array | null }>(
        select.get(threadId, ns, channel, String(version)),
      );
      if (!row?.value || !row.type) continue;
      checkpoint.channel_values[channel] = await this.serde.loadsTyped(row.type, row.value);
    }
  }

  private async pruneNamespace(threadId: string, ns: string): Promise<number> {
    const rows = asRows<CpRow>(
      this.sqlite
        .prepare(
          `SELECT checkpoint_id, type, checkpoint FROM checkpoints
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
    const keep = selectRetainedCheckpointIds({
      idsNewestFirst: ids,
      maxCheckpoints: this.retention.maxCheckpoints,
      interruptIds,
      explicitPinsNewestFirst: explicit,
      maxInterruptPoints: this.retention.maxInterruptPoints,
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

  private maybeVacuum(deleted: number): void {
    if (!this.retention.enabled || this.retention.vacuum === "never" || deleted <= 0) return;
    let freelist = 0;
    let pages = 0;
    try {
      freelist = Number(this.sqlite.pragma("freelist_count", { simple: true }));
      pages = Number(this.sqlite.pragma("page_count", { simple: true }));
    } catch {
      return;
    }
    if (this.retention.vacuum !== "always" && !(freelist > 8 && freelist * 2 > pages)) return;
    try {
      this.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      this.sqlite.exec("VACUUM");
    } catch {
      // VACUUM fails if a statement is still open. A later prune retries.
    }
  }
}
