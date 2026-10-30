/**
 * Durable Postgres checkpointer for flowgraph.
 *
 * Wraps the official LangGraph PostgresSaver so a graph's state survives
 * process restarts and is shareable across hosts. Pass the result to
 * `compileGraph(spec, { checkpointer })`.
 *
 * @example
 * import { createPostgresCheckpointer } from "@flowgraph/checkpoint-postgres";
 * const checkpointer = await createPostgresCheckpointer(process.env.DATABASE_URL!);
 * const compiled = await compileGraph(spec, { checkpointer });
 *
 * The first call runs `setup()` to create the checkpoint tables (idempotent).
 */

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import pg from "pg";
import { DEFAULT_SETUP_LOCK_TIMEOUT_MS, retrySetupRace, withSetupLock } from "./setup-lock.js";
import type { GraphNameRegistry, ThreadOwnerRegistry } from "@flowgraph/core";
import {
  createPostgresGraphNameRegistry,
  createPostgresThreadOwnerRegistry,
  createPostgresMemoryBackend,
  maybeSweepPostgres,
  quoteSchema,
  type PostgresMemoryBackend,
} from "./memory.js";

export interface PostgresCheckpointerOptions {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/db */
  connectionString: string;
  /** Run setup() to create the checkpoint tables. Default: true. */
  setup?: boolean;
  /** How long to wait for another host's setup to finish before failing. Default 60s. */
  setupLockTimeoutMs?: number;
}

/**
 * Create a Postgres-backed checkpointer. Runs `setup()` (idempotent table
 * creation) unless disabled.
 */
export async function createPostgresCheckpointer(
  connStringOrOptions: string | PostgresCheckpointerOptions,
): Promise<BaseCheckpointSaver> {
  const connectionString =
    typeof connStringOrOptions === "string"
      ? connStringOrOptions
      : connStringOrOptions.connectionString;
  const doSetup =
    typeof connStringOrOptions === "string" ? true : connStringOrOptions.setup !== false;

  if (!connectionString) {
    throw new Error("createPostgresCheckpointer: a connection string is required.");
  }

  const saver = PostgresSaver.fromConnString(connectionString);
  if (doSetup) {
    const timeoutMs = typeof connStringOrOptions === "string" ? undefined : connStringOrOptions.setupLockTimeoutMs;
    await withSetupLock({ connectionString }, "public", () => retrySetupRace(() => saver.setup()), { timeoutMs });
  }
  return saver as unknown as BaseCheckpointSaver;
}

/** Connection settings for a dedicated client that reaches the same database as `pool`. */
function clientConfigOf(pool: pg.Pool): pg.ClientConfig {
  const { max: _max, min: _min, idleTimeoutMillis: _i, allowExitOnIdle: _a, maxUses: _m, log: _l, Client: _c, ...rest } =
    pool.options as pg.PoolOptions & { log?: unknown; Client?: unknown; maxUses?: unknown };
  return rest as pg.ClientConfig;
}

export interface PostgresBackendOptions {
  /** Postgres connection string. Ignored when `pool` is given. */
  connectionString?: string;
  /** An existing pool to share. The caller keeps ownership: close() will not end it. */
  pool?: pg.Pool;
  /** Schema for checkpoint and memory tables. Default "public". */
  schema?: string;
  /** Run checkpointer setup() and memory migrations. Default true. */
  setup?: boolean;
  /**
   * How long to wait for another host's schema setup (the per-schema advisory
   * lock) before failing with a timeout error. Default 60s.
   */
  setupLockTimeoutMs?: number;
  /** Sweep expired memory on open when the last sweep is older than this. Default 1h. */
  sweepIntervalMs?: number;
  /** Extra pg.Pool settings when this call creates the pool (e.g. max, allowExitOnIdle). */
  poolConfig?: Omit<pg.PoolConfig, "connectionString">;
  /**
   * Called when an idle pooled connection fails, e.g. the server terminated it
   * (57P01) or the network dropped. The pool discards that connection and opens
   * a new one on the next query. Only used when this call creates the pool.
   * Default: a one-line console.warn.
   */
  onPoolError?: (err: Error) => void;
}

export interface PostgresBackend {
  /** The shared pool (checkpoints and memory use the same connections). */
  pool: pg.Pool;
  checkpointer: BaseCheckpointSaver;
  memory: PostgresMemoryBackend;
  /** Graph-name ownership (first registrant owns a name within an org), in the same schema. */
  graphNames: GraphNameRegistry;
  /** Thread ownership (who started each thread id), next to the checkpoints. */
  threadOwners: ThreadOwnerRegistry;
  /** Ends the pool if this call created it. */
  close(): Promise<void>;
}

/**
 * Open one Postgres database for both checkpoints and scoped memory, over one
 * pool. Runs checkpointer setup and memory migrations (forward-only) under a
 * per-schema advisory lock, so concurrent cold starts on many hosts are safe,
 * then sweeps expired memory when
 * the last sweep is older than an hour.
 *
 * @example
 * const { checkpointer, memory } = await openPostgresBackend(process.env.DATABASE_URL!);
 * const compiled = await compileGraph(spec, { checkpointer, memory: { backend: memory, identity } });
 */
export async function openPostgresBackend(connStringOrOptions: string | PostgresBackendOptions): Promise<PostgresBackend> {
  const opts: PostgresBackendOptions =
    typeof connStringOrOptions === "string" ? { connectionString: connStringOrOptions } : connStringOrOptions;
  if (!opts.pool && !opts.connectionString) {
    throw new Error("openPostgresBackend: a connection string or pool is required.");
  }
  const schema = opts.schema ?? "public";
  quoteSchema(schema);
  const owned = !opts.pool;
  const pool = opts.pool ?? new pg.Pool({ ...opts.poolConfig, connectionString: opts.connectionString });
  // Without a listener, an idle connection's error is an unhandled 'error' event that crashes the process.
  if (owned) {
    pool.on(
      "error",
      opts.onPoolError ??
        ((err: Error) => {
          console.warn(`flowgraph: postgres idle connection error (${(err as { code?: string }).code ?? err.message}); it will be replaced`);
        }),
    );
  }
  try {
    const saver = new PostgresSaver(pool, undefined, { schema });
    const setup = opts.setup !== false;
    const memory = setup
      ? await withSetupLock(
          clientConfigOf(pool),
          schema,
          async () => {
            await retrySetupRace(() => saver.setup());
            return createPostgresMemoryBackend(pool, { schema });
          },
          { timeoutMs: opts.setupLockTimeoutMs },
        )
      : await createPostgresMemoryBackend(pool, { schema, migrate: false });
    await maybeSweepPostgres(memory, opts.sweepIntervalMs ?? 3_600_000);
    // Migrations above created its table.
    const graphNames = await createPostgresGraphNameRegistry(pool, { schema, migrate: false });
    const threadOwners = await createPostgresThreadOwnerRegistry(pool, { schema, migrate: false });
    let closed = false;
    return {
      pool,
      checkpointer: saver as unknown as BaseCheckpointSaver,
      memory,
      graphNames,
      threadOwners,
      async close() {
        if (closed || !owned) return;
        closed = true;
        await pool.end();
      },
    };
  } catch (err) {
    if (owned) await pool.end().catch(() => undefined);
    throw err;
  }
}

export { PostgresSaver, DEFAULT_SETUP_LOCK_TIMEOUT_MS };
export {
  createPostgresMemoryBackend,
  createPostgresGraphNameRegistry,
  createPostgresThreadOwnerRegistry,
  maybeSweepPostgres,
  memoryWriteLockKey,
  migratePostgresMemorySchema,
  POSTGRES_MEMORY_MIGRATIONS,
  type PostgresMemoryBackend,
  type PostgresMemoryOptions,
} from "./memory.js";
