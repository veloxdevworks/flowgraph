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
  /**
   * Newest checkpoints kept per (thread, namespace). A positive integer.
   * Default 40. `0`, fractions, and negatives are rejected.
   */
  maxCheckpoints?: number | undefined;
  /**
   * Interrupt, resume, and error checkpoints kept in addition to the newest
   * window, most recent first. Default 8. `0` keeps none outside the window.
   * The newest checkpoint is always kept either way. Fractions and negatives
   * are rejected.
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

function countInt(n: unknown, name: string, min: number): number {
  const bound = min === 1 ? "a positive integer" : "a non-negative integer";
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min) {
    throw new Error(
      `Invalid ${name}: ${JSON.stringify(n)}. Expected ${bound} up to ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return n;
}

/** `error.code` when resume names a checkpoint retention has already dropped. */
export const CHECKPOINT_PRUNED = "CHECKPOINT_PRUNED";

export function checkpointPrunedError(
  threadId: string,
  checkpointId: string,
  opts?: { retention?: boolean },
): Error & { code: typeof CHECKPOINT_PRUNED } {
  const why = opts?.retention
    ? " It is missing or was pruned; resume from a checkpoint that is still kept."
    : "";
  const err = new Error(
    `Checkpoint "${checkpointId}" for thread "${threadId}" is not available.${why}`,
  ) as Error & { code: typeof CHECKPOINT_PRUNED };
  err.code = CHECKPOINT_PRUNED;
  return err;
}

/**
 * In-process guard so a sweep cannot delete a thread this process is running
 * or has left waiting at an interrupt. Parking is per run: one run finishing
 * does not clear another run's interrupt. Explicit `deleteThread` does not
 * consult this guard.
 */
export class ThreadRunGuard {
  private seq = 0;
  private readonly inFlight = new Map<string, Set<number>>();
  private readonly parked = new Map<string, Set<number>>();

  begin(threadId: string): number {
    const token = ++this.seq;
    const live = this.inFlight.get(threadId) ?? new Set<number>();
    live.add(token);
    this.inFlight.set(threadId, live);
    return token;
  }

  /**
   * @param resumed True when this run continued an interrupt. That releases
   * one earlier park before this run parks again or finishes, so a thread
   * that pauses several times does not stay parked after the last run ends.
   * A finish that did not resume leaves every other park in place.
   * @param releaseOnly Drop this run's token and do not park it. A run that
   * stops before it starts uses this so it does not hold the thread.
   */
  end(threadId: string, status: CheckpointThreadStatus, token: number, resumed = false, releaseOnly = false): void {
    const live = this.inFlight.get(threadId);
    live?.delete(token);
    if (live && live.size === 0) this.inFlight.delete(threadId);
    const parks = this.parked.get(threadId) ?? new Set<number>();
    if (releaseOnly) {
      parks.delete(token);
      if (parks.size === 0) this.parked.delete(threadId);
      else this.parked.set(threadId, parks);
      return;
    }
    if (resumed) {
      const earlier = parks.values().next().value;
      if (earlier !== undefined) parks.delete(earlier);
    }
    if (status === "paused") parks.add(token);
    else parks.delete(token);
    if (parks.size === 0) this.parked.delete(threadId);
    else this.parked.set(threadId, parks);
  }

  held(threadId: string): boolean {
    return (this.inFlight.get(threadId)?.size ?? 0) > 0 || (this.parked.get(threadId)?.size ?? 0) > 0;
  }
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
        : countInt(merged.maxFinishedThreads, "maxFinishedThreads", 0);

  return {
    enabled,
    maxCheckpoints: countInt(
      merged.maxCheckpoints ?? DEFAULT_CHECKPOINT_RETENTION.maxCheckpoints,
      "maxCheckpoints",
      1,
    ),
    maxInterruptPoints: countInt(
      merged.maxInterruptPoints ?? DEFAULT_CHECKPOINT_RETENTION.maxInterruptPoints,
      "maxInterruptPoints",
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

/** Status row saved before a run marks the thread active. */
export interface SavedThreadStatus {
  status: CheckpointThreadStatus;
  updatedAt: number;
}

export interface CheckpointRetentionSaver {
  noteThreadStatus(threadId: string, status: CheckpointThreadStatus, now?: number): Promise<void> | void;
  sweep(now?: number): Promise<void> | void;
  /** Remember this thread's graph policy. Graph fields override the host saver. */
  noteThreadPolicy?(threadId: string, policy: ResolvedCheckpointRetention): void;
  /**
   * Mark the thread active before the run reads checkpoint state, when thread
   * deletion is on. Returns a token stored on that row. A later restore
   * matches the token, so a newer row from another run is left alone.
   * A crash after this and before the checkpoint row is written leaves the
   * thread active until a later run or `deleteThread`.
   */
  markThreadActive?(threadId: string): string | undefined | Promise<string | undefined>;
  /** Status row for this thread, if this saver has recorded one. */
  savedThreadStatus?(threadId: string): SavedThreadStatus | undefined | Promise<SavedThreadStatus | undefined>;
  /**
   * Put back the status from before {@link markThreadActive}, only when the
   * row is still this call's active mark. `undefined` removes that row.
   * A newer status from another run is left alone. Checkpoints stay.
   */
  restoreThreadStatus?(
    threadId: string,
    prior: SavedThreadStatus | undefined,
    activeMark: string,
  ): void | Promise<void>;
  /** Mark a thread in use. Returns a token for {@link endThreadRun}. */
  beginThreadRun?(threadId: string): number;
  /**
   * Pair with {@link beginThreadRun}. `paused` parks this run's token.
   * `resumed` lets a finished resume clear one other parked interrupt, not every one.
   * `releaseOnly` drops this run's token and does not park it.
   */
  endThreadRun?(
    threadId: string,
    status: CheckpointThreadStatus,
    token?: number,
    resumed?: boolean,
    releaseOnly?: boolean,
  ): void;
}

export function isRetentionSaver(saver: unknown): saver is CheckpointRetentionSaver {
  return (
    !!saver &&
    typeof saver === "object" &&
    typeof (saver as CheckpointRetentionSaver).noteThreadStatus === "function"
  );
}
