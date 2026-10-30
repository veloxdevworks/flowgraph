/**
 * Bounds checkpoint storage.
 *
 * LangGraph writes a checkpoint (and pending writes) on every superstep and
 * never deletes them. SQLite stores every channel value inside every
 * checkpoint row; Postgres stores one blob per channel version and also never
 * deletes old versions. Finished threads are left in place. A few thousand
 * short runs, or one long thread whose state grows, therefore grow the
 * database without a ceiling.
 *
 * Retention keeps the newest checkpoints per thread namespace, plus a bounded
 * set of interrupt and resume points, and deletes finished threads after a
 * TTL or once a count cap is exceeded. The newest checkpoint of a thread is
 * always kept, and a thread marked paused is never deleted, so resume of a
 * paused run still works.
 */

/** Pending-write channels that mark a checkpoint as an interrupt or resume point. */
export const CHECKPOINT_PIN_CHANNELS: ReadonlySet<string> = new Set([
  "__interrupt__",
  "__resume__",
  "__error__",
]);

export type CheckpointThreadStatus = "active" | "paused" | "finished";

export type CheckpointVacuum = "auto" | "always" | "never";

/**
 * Host or graph retention settings. Omitted fields use
 * {@link DEFAULT_CHECKPOINT_RETENTION}. `false` turns retention off.
 */
export interface CheckpointRetentionInput {
  enabled?: boolean | undefined;
  /** Newest checkpoints kept per (thread, namespace). Minimum 1. Default 40. */
  maxCheckpoints?: number | undefined;
  /**
   * Interrupt, resume, and error checkpoints kept in addition to the newest
   * window, most recent first. Default 8. `0` keeps none outside the window.
   * The newest checkpoint is always kept either way.
   */
  maxInterruptPoints?: number | undefined;
  /**
   * Delete finished threads whose last activity is older than this.
   * A duration string (`14d`, `12h`) or milliseconds. `null` disables the
   * age sweep. Default 14 days. Paused threads are never deleted.
   */
  finishedTtl?: string | number | null | undefined;
  /**
   * How many finished threads to keep. Oldest are deleted first. `null`
   * disables the count cap. `0` deletes a thread as soon as its run completes.
   * Default 200. Paused threads do not count and are never deleted.
   */
  maxFinishedThreads?: number | null | undefined;
  /**
   * Store each channel version once (sqlite and in-memory). Postgres already
   * versions blobs; unreferenced versions are deleted on prune either way.
   * Default true.
   */
  dedupeChannels?: boolean | undefined;
  /**
   * `auto` (default) reclaims free pages after deletes: sqlite when free pages
   * exceed live data, postgres after about 100 dropped checkpoints.
   * `always` reclaims on every sweep. `never` leaves free pages to the file.
   */
  vacuum?: CheckpointVacuum | undefined;
}

export interface ResolvedCheckpointRetention {
  enabled: boolean;
  maxCheckpoints: number;
  maxInterruptPoints: number;
  /** `null` disables the age sweep. */
  finishedTtlMs: number | null;
  /** `null` disables the count cap. */
  maxFinishedThreads: number | null;
  dedupeChannels: boolean;
  vacuum: CheckpointVacuum;
}

export const DEFAULT_CHECKPOINT_RETENTION: ResolvedCheckpointRetention = {
  enabled: true,
  maxCheckpoints: 40,
  maxInterruptPoints: 8,
  finishedTtlMs: 14 * 86_400_000,
  maxFinishedThreads: 200,
  dedupeChannels: true,
  vacuum: "auto",
};

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

export function retentionDurationMs(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid retention duration: ${value}`);
    return value;
  }
  const match = DURATION.exec(value.trim());
  if (!match?.[1] || !match[2]) throw new Error(`Invalid retention duration: "${value}"`);
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      throw new Error(`Invalid retention duration: "${value}"`);
  }
}

function clampInt(n: number, min: number): number {
  if (!Number.isFinite(n)) throw new Error(`Invalid retention count: ${n}`);
  return Math.max(min, Math.floor(n));
}

/**
 * Merge graph and host retention settings. Host fields win. `false` from the
 * host disables retention; `false` from the graph disables it unless the host
 * turns it back on.
 */
export function resolveCheckpointRetention(
  graph?: boolean | CheckpointRetentionInput | null,
  host?: boolean | CheckpointRetentionInput | null,
): ResolvedCheckpointRetention {
  let enabled = DEFAULT_CHECKPOINT_RETENTION.enabled;
  const merged: CheckpointRetentionInput = {};
  for (const src of [graph, host]) {
    if (src === undefined || src === null) continue;
    if (src === false) {
      enabled = false;
      continue;
    }
    if (src === true) {
      enabled = true;
      continue;
    }
    if (src.enabled !== undefined) enabled = src.enabled;
    if (src.maxCheckpoints !== undefined) merged.maxCheckpoints = src.maxCheckpoints;
    if (src.maxInterruptPoints !== undefined) merged.maxInterruptPoints = src.maxInterruptPoints;
    if (src.finishedTtl !== undefined) merged.finishedTtl = src.finishedTtl;
    if (src.maxFinishedThreads !== undefined) merged.maxFinishedThreads = src.maxFinishedThreads;
    if (src.dedupeChannels !== undefined) merged.dedupeChannels = src.dedupeChannels;
    if (src.vacuum !== undefined) merged.vacuum = src.vacuum;
  }

  const finishedTtlMs =
    merged.finishedTtl === undefined
      ? DEFAULT_CHECKPOINT_RETENTION.finishedTtlMs
      : merged.finishedTtl === null
        ? null
        : retentionDurationMs(merged.finishedTtl);
  const maxFinishedThreads =
    merged.maxFinishedThreads === undefined
      ? DEFAULT_CHECKPOINT_RETENTION.maxFinishedThreads
      : merged.maxFinishedThreads === null
        ? null
        : clampInt(merged.maxFinishedThreads, 0);

  return {
    enabled,
    maxCheckpoints: clampInt(merged.maxCheckpoints ?? DEFAULT_CHECKPOINT_RETENTION.maxCheckpoints, 1),
    maxInterruptPoints: clampInt(
      merged.maxInterruptPoints ?? DEFAULT_CHECKPOINT_RETENTION.maxInterruptPoints,
      0,
    ),
    finishedTtlMs,
    maxFinishedThreads,
    dedupeChannels: merged.dedupeChannels ?? DEFAULT_CHECKPOINT_RETENTION.dedupeChannels,
    vacuum: merged.vacuum ?? DEFAULT_CHECKPOINT_RETENTION.vacuum,
  };
}

export interface RetainCheckpointsArgs {
  /** Checkpoint ids, newest first (uuid6 lexicographic order). */
  idsNewestFirst: readonly string[];
  maxCheckpoints: number;
  /** Ids whose pending writes include an interrupt, resume, or error channel. */
  interruptIds: readonly string[];
  /** Ids pinned because a run paused on them, newest pin first. */
  explicitPinsNewestFirst: readonly string[];
  maxInterruptPoints: number;
}

/**
 * Checkpoints that must survive a prune. The newest `maxCheckpoints` are
 * kept (at least the newest one). Interrupt and resume points outside that
 * window are kept too, up to `maxInterruptPoints`, most recent first.
 */
export function selectRetainedCheckpointIds(args: RetainCheckpointsArgs): Set<string> {
  const keep = new Set<string>();
  const window = Math.max(1, args.maxCheckpoints);
  for (const id of args.idsNewestFirst.slice(0, window)) keep.add(id);
  const head = args.idsNewestFirst[0];
  if (head) keep.add(head);
  if (args.maxInterruptPoints <= 0) return keep;

  const explicit = new Set(args.explicitPinsNewestFirst);
  const interrupts = new Set(args.interruptIds);
  let extra = 0;
  for (const id of args.idsNewestFirst) {
    if (extra >= args.maxInterruptPoints) break;
    if (keep.has(id)) continue;
    if (!explicit.has(id) && !interrupts.has(id)) continue;
    keep.add(id);
    extra += 1;
  }
  return keep;
}

/**
 * Map a finished run to the thread status retention is allowed to delete.
 * Paused, interrupted, and aborted runs stay resumable. An error that still
 * has a pending interrupt stays resumable too.
 */
export function retentionStatusForRun(
  status: "completed" | "interrupted" | "paused" | "error" | "aborted",
  hasInterrupts: boolean,
): CheckpointThreadStatus {
  if (status === "interrupted" || status === "paused" || status === "aborted") return "paused";
  if (status === "error" && hasInterrupts) return "paused";
  return "finished";
}

export interface CheckpointRetentionSaver {
  noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now?: number): Promise<void> | void;
  sweep(now?: number): Promise<void> | void;
}

export function isRetentionSaver(saver: unknown): saver is CheckpointRetentionSaver {
  return (
    !!saver &&
    typeof saver === "object" &&
    typeof (saver as CheckpointRetentionSaver).noteThreadStatus === "function"
  );
}
