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
 * Retention keeps the newest checkpoints on each branch of a thread, plus a
 * bounded set of interrupt and resume points. Deleting a finished thread is
 * opt-in. The newest checkpoint on a branch is always kept. Errored, aborted,
 * and paused threads are never deleted.
 */

/**
 * Channel values at most this large stay inside the checkpoint row.
 * A separate blob row costs a page of overhead, so externalizing small or
 * one-off values makes a database of many short threads larger, not smaller.
 * Larger values are stored once when a later checkpoint repeats the version.
 */
export const CHECKPOINT_INLINE_MAX_BYTES = 4096;

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
   * Opt-in: delete finished threads whose last activity is older than this.
   * A duration string (`14d`, `12h`) or milliseconds. `null` (the default)
   * does not delete threads by age. Errored, aborted, and paused threads are
   * never deleted.
   */
  finishedTtl?: string | number | null | undefined;
  /**
   * Opt-in: how many finished threads to keep. Oldest are deleted first.
   * `null` (the default) does not cap finished threads. `0` deletes a thread
   * as soon as its run completes. Must be a non-negative integer or null.
   */
  maxFinishedThreads?: number | null | undefined;
  /**
   * Store each channel version once (sqlite and in-memory). Postgres already
   * versions blobs; unreferenced versions are deleted on prune either way.
   * Default true.
   */
  dedupeChannels?: boolean | undefined;
  /**
   * `auto` (default) runs sqlite incremental vacuum when the file was created
   * with incremental auto_vacuum. It does not take a blocking VACUUM.
   * `always` opts into a blocking VACUUM. `never` does neither.
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
  /** Thread deletion is opt-in. */
  finishedTtlMs: null,
  maxFinishedThreads: null,
  dedupeChannels: true,
  vacuum: "auto",
};

/** True when this policy may delete a finished thread. */
export function threadDeletionRequested(policy: ResolvedCheckpointRetention): boolean {
  return policy.enabled && (policy.finishedTtlMs !== null || policy.maxFinishedThreads !== null);
}

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

function nonNegativeInt(n: number, name: string): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${name}: ${n}. Expected a non-negative integer or null.`);
  }
  return n;
}

/**
 * Merge host and graph retention settings. The graph wins on every field it
 * sets, so a graph that opts out (`retention: false`) or sets its own window
 * is honored on a shared database. The host fills anything the graph omits.
 */
export function resolveCheckpointRetention(
  graph?: boolean | CheckpointRetentionInput | null,
  host?: boolean | CheckpointRetentionInput | null,
): ResolvedCheckpointRetention {
  let enabled = DEFAULT_CHECKPOINT_RETENTION.enabled;
  const merged: CheckpointRetentionInput = {};
  for (const src of [host, graph]) {
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
    else if (src === graph) enabled = true;
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
        : nonNegativeInt(merged.maxFinishedThreads, "maxFinishedThreads");

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
  /**
   * Parent checkpoint id for each id. When set, `maxCheckpoints` is counted
   * along each branch (each leaf and its ancestors), so a fork keeps its own
   * window. When omitted, the newest ids form one linear window.
   */
  parentOf?: ReadonlyMap<string, string | null | undefined> | undefined;
  maxCheckpoints: number;
  /** Ids whose pending writes include an interrupt, resume, or error channel. */
  interruptIds: readonly string[];
  /** Ids pinned because a run paused on them, newest pin first. */
  explicitPinsNewestFirst: readonly string[];
  maxInterruptPoints: number;
}

/**
 * Checkpoints that must survive a prune. Each branch keeps its newest
 * `maxCheckpoints` (at least the leaf). Interrupt and resume points outside
 * those windows are kept too, up to `maxInterruptPoints`, most recent first.
 */
export function selectRetainedCheckpointIds(args: RetainCheckpointsArgs): Set<string> {
  const keep = new Set<string>();
  const window = Math.max(1, args.maxCheckpoints);
  const present = new Set(args.idsNewestFirst);
  if (args.parentOf) {
    const isParent = new Set<string>();
    for (const id of args.idsNewestFirst) {
      const parent = args.parentOf.get(id);
      if (parent && present.has(parent)) isParent.add(parent);
    }
    const leaves = args.idsNewestFirst.filter((id) => !isParent.has(id));
    const tips = leaves.length > 0 ? leaves : args.idsNewestFirst.slice(0, 1);
    for (const leaf of tips) {
      let kept = 0;
      let current: string | null | undefined = leaf;
      const seen = new Set<string>();
      while (current && present.has(current) && kept < window && !seen.has(current)) {
        seen.add(current);
        keep.add(current);
        kept += 1;
        const parent = args.parentOf.get(current);
        current = parent ?? undefined;
      }
    }
  } else {
    for (const id of args.idsNewestFirst.slice(0, window)) keep.add(id);
  }
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
 * Only a completed run may be deleted, and only when thread deletion is
 * turned on. Interrupted, paused, aborted, and errored runs stay.
 */
export function retentionStatusForRun(
  status: "completed" | "interrupted" | "paused" | "error" | "aborted",
): CheckpointThreadStatus {
  return status === "completed" ? "finished" : "paused";
}

export interface CheckpointRetentionSaver {
  noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now?: number): Promise<void> | void;
  sweep(now?: number): Promise<void> | void;
  /** Remember this thread's graph policy. Graph fields override the host saver. */
  noteThreadPolicy?(threadId: string, policy: ResolvedCheckpointRetention): void;
}

export function isRetentionSaver(saver: unknown): saver is CheckpointRetentionSaver {
  return (
    !!saver &&
    typeof saver === "object" &&
    typeof (saver as CheckpointRetentionSaver).noteThreadStatus === "function"
  );
}
