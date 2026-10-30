/**
 * Durable SQLite checkpointer for flowgraph.
 *
 * Wraps the official LangGraph SqliteSaver so a graph's state survives
 * process restarts. Pass the result to `compileGraph(spec, { checkpointer })`.
 *
 * @example
 * import { createSqliteCheckpointer } from "@flowgraph/checkpoint-sqlite";
 * const checkpointer = createSqliteCheckpointer(".flowgraph/checkpoints.db");
 * const compiled = await compileGraph(spec, { checkpointer });
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  createSqliteMemoryBackend,
  maybeSweep,
  openDatabase,
  type SqliteDatabase,
  type SqliteMemoryBackend,
} from "./memory.js";

export interface SqliteCheckpointerOptions {
  /** Path to the .db file, or ":memory:" for an in-process DB. Default: ".flowgraph/checkpoints.db" */
  path?: string;
}

/**
 * Create a SQLite-backed checkpointer. Creates parent directories as needed.
 */
export function createSqliteCheckpointer(
  pathOrOptions: string | SqliteCheckpointerOptions = {},
): BaseCheckpointSaver {
  const dbPath =
    typeof pathOrOptions === "string"
      ? pathOrOptions
      : pathOrOptions.path ?? ".flowgraph/checkpoints.db";

  if (dbPath !== ":memory:") {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
  }

  return SqliteSaver.fromConnString(dbPath) as unknown as BaseCheckpointSaver;
}

export interface SqliteBackendOptions extends SqliteCheckpointerOptions {
  /** Sweep expired memory on open when the last sweep is older than this. Default 1h. */
  sweepIntervalMs?: number;
  /** SQLite busy_timeout for cross-process writers. Default 5000. */
  busyTimeoutMs?: number;
}

export interface SqliteBackend {
  /** The shared connection (checkpoints and memory live in the same file). */
  db: SqliteDatabase;
  checkpointer: BaseCheckpointSaver;
  memory: SqliteMemoryBackend;
  close(): void;
}

/**
 * Open one SQLite file for both checkpoints and scoped memory, on one
 * connection. Runs memory migrations (forward-only) and sweeps expired memory
 * when the last sweep is older than an hour.
 *
 * @example
 * const { checkpointer, memory } = await openSqliteBackend(".flowgraph/checkpoints.db");
 * const compiled = await compileGraph(spec, { checkpointer, memory: { backend: memory, identity } });
 */
export async function openSqliteBackend(pathOrOptions: string | SqliteBackendOptions = {}): Promise<SqliteBackend> {
  const opts: SqliteBackendOptions = typeof pathOrOptions === "string" ? { path: pathOrOptions } : pathOrOptions;
  const dbPath = opts.path ?? ".flowgraph/checkpoints.db";
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = openDatabase(dbPath, opts.busyTimeoutMs);
  const memory = createSqliteMemoryBackend(db);
  await maybeSweep(memory, opts.sweepIntervalMs ?? 3_600_000);
  const checkpointer = new SqliteSaver(db as never) as unknown as BaseCheckpointSaver;
  return {
    db,
    checkpointer,
    memory,
    close() {
      if (db.open) db.close();
    },
  };
}

export { SqliteSaver };
export {
  createSqliteMemoryBackend,
  migrateMemorySchema,
  maybeSweep,
  MEMORY_MIGRATIONS,
  type SqliteDatabase,
  type SqliteMemoryBackend,
} from "./memory.js";
