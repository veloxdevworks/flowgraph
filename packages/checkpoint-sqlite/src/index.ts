/**
 * Durable SQLite checkpointer for flowgraph.
 *
 * Wraps the official LangGraph SqliteSaver so a graph's state survives
 * process restarts. Pass the result to `compileGraph(spec, { checkpointer })`.
 *
 * @example
 * import { createSqliteCheckpointer } from "@veloxdevworks/flowgraph-checkpoint-sqlite";
 * const checkpointer = createSqliteCheckpointer(".flowgraph/checkpoints.db");
 * const compiled = await compileGraph(spec, { checkpointer });
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

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

export { SqliteSaver };
