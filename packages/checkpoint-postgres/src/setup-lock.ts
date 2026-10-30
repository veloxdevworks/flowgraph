import pg from "pg";

/** Default bound on waiting for another host's schema setup. */
export const DEFAULT_SETUP_LOCK_TIMEOUT_MS = 60_000;

/**
 * SQLSTATEs a concurrent `CREATE ... IF NOT EXISTS` or migration-row insert
 * raises when two setups overlap: unique_violation, duplicate_object,
 * duplicate_table, duplicate_schema.
 */
const SETUP_RACE_CODES = new Set(["23505", "42710", "42P07", "42P06"]);

export function isSetupRaceError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && SETUP_RACE_CODES.has(code);
}

/**
 * Run an idempotent setup step, re-running it when it loses a race with an
 * overlapping setup (which can happen when a lock holder's connection dies
 * mid-setup and a waiter takes the lock). The re-run sees the objects the other
 * setup created and skips them. Any other error is thrown as is.
 */
export async function retrySetupRace<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isSetupRaceError(err)) throw err;
      await sleep(100 * attempt);
    }
  }
}

export interface SetupLockOptions {
  /** Give up waiting for the lock after this long. Default 60s. */
  timeoutMs?: number | undefined;
}

/**
 * Run schema setup under a session-level advisory lock per schema, so
 * concurrent cold starts serialize. Waiting is bounded: the lock is polled with
 * pg_try_advisory_lock and backoff until `timeoutMs`, then a clear error is
 * thrown (a host stuck mid-setup would otherwise block every other host).
 *
 * The lock lives on a dedicated client, not one from the shared pool: the
 * setup itself takes pool connections, and holding the lock on one of them
 * would deadlock a pool of size 1. Session advisory locks need a session-pooled
 * connection; PgBouncer in transaction mode does not keep them.
 */
export async function withSetupLock<T>(
  config: pg.ClientConfig,
  schema: string,
  fn: () => Promise<T>,
  opts: SetupLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SETUP_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`setupLockTimeoutMs must be a non-negative number of milliseconds (got ${timeoutMs})`);
  }
  const key = setupLockKey(schema);
  const client = new pg.Client(config);
  // The server may terminate this client while it is idle; without a listener
  // that is an unhandled 'error' event. If it happens while we hold the lock,
  // the lock is released and another host may set up concurrently; setup steps
  // tolerate that overlap (retrySetupRace). Errors on the lock queries
  // themselves still reject those queries.
  client.on("error", () => undefined);
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    let delay = 50;
    for (;;) {
      const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [key]);
      if (rows[0]?.ok) break;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw Object.assign(
          new Error(
            `flowgraph: timed out after ${timeoutMs}ms waiting for the schema setup lock on "${schema}". ` +
              `Another host is running setup or is stuck holding the lock (find it with ` +
              `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted). Raise setupLockTimeoutMs to wait longer.`,
          ),
          { code: "FLOWGRAPH_SETUP_LOCK_TIMEOUT" },
        );
      }
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, 1_000);
    }
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function setupLockKey(schema: string): string {
  return `flowgraph:setup:${schema}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
