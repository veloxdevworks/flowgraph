/**
 * Durable Postgres checkpointer for flowgraph.
 *
 * Wraps the official LangGraph PostgresSaver so a graph's state survives
 * process restarts and is shareable across hosts. Pass the result to
 * `compileGraph(spec, { checkpointer })`.
 *
 * @example
 * import { createPostgresCheckpointer } from "@veloxdevworks/flowgraph-checkpoint-postgres";
 * const checkpointer = await createPostgresCheckpointer(process.env.DATABASE_URL!);
 * const compiled = await compileGraph(spec, { checkpointer });
 *
 * The first call runs `setup()` to create the checkpoint tables (idempotent).
 */

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

export interface PostgresCheckpointerOptions {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/db */
  connectionString: string;
  /** Run setup() to create the checkpoint tables. Default: true. */
  setup?: boolean;
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
    await saver.setup();
  }
  return saver as unknown as BaseCheckpointSaver;
}

export { PostgresSaver };
