/**
 * Clean up what crashed writers leave in the graph store.
 *
 * - Temporary files (`.{name}.{pid}.{hex}.tmp`) are staged next to their
 *   target and renamed or linked into place within one request. One that is
 *   older than `maxAgeMs` belongs to a writer that died, and is removed.
 * - A meta file with no graph file next to it is a thread whose create
 *   stopped between claiming the id and moving the graph into place. The
 *   sweep reports it and leaves it: the file is the owner's claim on the
 *   thread id, and removing it would let another caller take the id. Listing
 *   shows such a thread as `error` once it is older than `maxAgeMs` (see
 *   `listPersistedGraphs`), and the owner's next upload stores the graph.
 *
 * Every server sharing a store can sweep it: removing a file another server
 * already removed is not an error, and nothing younger than `maxAgeMs` is
 * touched, so a write in progress on another server is left alone.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GRAPH_META_SUFFIX, isStagedFileName } from "./graph-source.js";
import { errorFields, log } from "./metrics.js";

/** Default age after which a leftover temporary file or graph-less meta file is swept: 1 hour. */
export const GRAPH_STORE_SWEEP_MAX_AGE_MS = 3_600_000;
/** Default time between sweeps: 1 hour. */
export const GRAPH_STORE_SWEEP_INTERVAL_MS = 3_600_000;
/** Smallest accepted `maxAgeMs`: a temporary file younger than this may still be being written. */
export const GRAPH_STORE_SWEEP_MIN_AGE_MS = 60_000;
/** Longest accepted interval: the largest delay a Node timer honors (2^31-1 ms). */
export const GRAPH_STORE_SWEEP_MAX_INTERVAL_MS = 2_147_483_647;

export interface GraphStoreSweepResult {
  /** Leftover temporary files removed. */
  tempFilesRemoved: number;
  /** Meta files older than `maxAgeMs` with no graph file, by the thread id their file name spells. */
  orphanedMetas: string[];
  /** Files that could not be checked or removed (logged; the sweep went on with the next file). */
  filesFailed: number;
}

export interface SweepGraphStoreOptions {
  /** Age after which a leftover is swept. */
  maxAgeMs: number;
  /** The time to sweep as of, in ms since the epoch. */
  now: number;
  /**
   * Thread ids already logged as orphaned. A new orphan is logged at info and
   * added; one already in the set is not logged again. The sweeper keeps one
   * set for its lifetime, so each orphan is logged once per process.
   */
  reportedOrphans?: Set<string>;
}

/**
 * Age in ms of a regular file, or undefined when it is gone or is anything
 * else. `lstat`, not `stat`: a symlink is never followed, so a link named
 * like a temporary file is left alone, as is whatever it points at.
 */
async function ageOf(file: string, now: number): Promise<number | undefined> {
  try {
    const st = await fs.lstat(file);
    return st.isFile() ? now - st.mtimeMs : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Sweep `dir` once. A file that cannot be checked or removed (permissions, an
 * I/O error) is logged as `graph-store.sweep file failed` and skipped; the
 * other files are still swept.
 */
export async function sweepGraphStore(dir: string, opts: SweepGraphStoreOptions): Promise<GraphStoreSweepResult> {
  const result: GraphStoreSweepResult = { tempFilesRemoved: 0, orphanedMetas: [], filesFailed: 0 };
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw err;
  }
  const present = new Set(names);
  const newOrphans: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (isStagedFileName(name)) {
        const age = await ageOf(file, opts.now);
        if (age === undefined || age < opts.maxAgeMs) continue;
        await fs.rm(file, { force: true });
        result.tempFilesRemoved++;
      } else if (name.endsWith(GRAPH_META_SUFFIX) && !present.has(name.slice(0, -".meta.json".length))) {
        const age = await ageOf(file, opts.now);
        // The graph may have been moved into place since the directory was read.
        if (age === undefined || age < opts.maxAgeMs || (await exists(file.slice(0, -".meta.json".length)))) continue;
        const threadId = name.slice(0, -GRAPH_META_SUFFIX.length);
        result.orphanedMetas.push(threadId);
        if (!opts.reportedOrphans?.has(threadId)) {
          opts.reportedOrphans?.add(threadId);
          newOrphans.push(threadId);
        }
      }
    } catch (err) {
      result.filesFailed++;
      log("warn", "graph-store.sweep file failed", { file, ...errorFields(err) });
    }
  }
  const summary = {
    tempFilesRemoved: result.tempFilesRemoved,
    orphanedMetas: result.orphanedMetas.length,
    filesFailed: result.filesFailed,
    ...(newOrphans.length ? { newOrphanedThreadIds: newOrphans.slice(0, 20) } : {}),
  };
  if (result.tempFilesRemoved > 0 || result.filesFailed > 0 || newOrphans.length > 0) {
    log("info", "graph-store.sweep", summary);
  } else if (result.orphanedMetas.length > 0) {
    log("debug", "graph-store.sweep", summary);
  }
  return result;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

export interface GraphStoreSweeper {
  /** Run one sweep now; a sweep already under way is returned instead of starting another. */
  sweepNow(): Promise<GraphStoreSweepResult>;
  /** Stop the timer and refuse further sweeps; resolves once a sweep under way has finished. */
  stop(): Promise<void>;
}

export interface GraphStoreSweeperOptions {
  /** Age after which leftovers are swept. Default {@link GRAPH_STORE_SWEEP_MAX_AGE_MS}. */
  maxAgeMs?: number | undefined;
  /** Time between sweeps; 0 sweeps only when asked (`sweepNow`). Default {@link GRAPH_STORE_SWEEP_INTERVAL_MS}. */
  intervalMs?: number | undefined;
  /** Clock, in ms since the epoch. Default `Date.now`. */
  now?: (() => number) | undefined;
  /** Called with each finished sweep's result. */
  onSweep?: ((result: GraphStoreSweepResult) => void) | undefined;
}

/**
 * Sweep `dir` every `intervalMs`. The timer is unref'd, so it never keeps
 * the process alive; a tick while a sweep is running joins it. A failed
 * sweep is logged and the sweeper keeps going.
 */
export function startGraphStoreSweeper(dir: string, opts: GraphStoreSweeperOptions = {}): GraphStoreSweeper {
  const maxAgeMs = opts.maxAgeMs ?? GRAPH_STORE_SWEEP_MAX_AGE_MS;
  const intervalMs = opts.intervalMs ?? GRAPH_STORE_SWEEP_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  let running: Promise<GraphStoreSweepResult> | undefined;
  let stopped = false;
  const reportedOrphans = new Set<string>();
  const sweepNow = (): Promise<GraphStoreSweepResult> => {
    if (stopped) return Promise.resolve({ tempFilesRemoved: 0, orphanedMetas: [], filesFailed: 0 });
    running ??= (async () => {
      try {
        const result = await sweepGraphStore(dir, { maxAgeMs, now: now(), reportedOrphans });
        opts.onSweep?.(result);
        return result;
      } catch (err) {
        log("warn", "graph-store.sweep failed", errorFields(err));
        return { tempFilesRemoved: 0, orphanedMetas: [], filesFailed: 0 };
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const timer = intervalMs > 0 ? setInterval(() => void sweepNow(), intervalMs) : undefined;
  timer?.unref?.();
  return {
    sweepNow,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await running;
    },
  };
}

/** Check sweep settings; throws on a value the sweeper cannot honor. */
export function assertGraphStoreSweepConfig(cfg: { maxAgeMs?: number | undefined; intervalMs?: number | undefined } = {}): void {
  const { maxAgeMs, intervalMs } = cfg;
  if (maxAgeMs !== undefined && !(Number.isSafeInteger(maxAgeMs) && maxAgeMs >= GRAPH_STORE_SWEEP_MIN_AGE_MS)) {
    throw new Error(`graphStoreSweep.maxAgeMs must be a whole number of milliseconds of at least ${GRAPH_STORE_SWEEP_MIN_AGE_MS} (got ${maxAgeMs})`);
  }
  if (intervalMs !== undefined && !(Number.isInteger(intervalMs) && (intervalMs === 0 || (intervalMs >= 1_000 && intervalMs <= GRAPH_STORE_SWEEP_MAX_INTERVAL_MS)))) {
    throw new Error(
      `graphStoreSweep.intervalMs must be 0 (sweep at startup only) or a whole number of milliseconds from 1000 to ${GRAPH_STORE_SWEEP_MAX_INTERVAL_MS} (got ${intervalMs})`,
    );
  }
}
