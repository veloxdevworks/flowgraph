/**
 * Compare unbounded checkpoint storage with retention.
 *
 *   node scripts/checkpoint-growth-bench.mjs --runs 2000
 *
 * Prints one JSON object. Sqlite file bytes include the wal and shm sidecars.
 * The in-memory figures are serialized checkpoint, write, and blob bytes.
 * Postgres runs only when FLOWGRAPH_TEST_POSTGRES_URL is set.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFrom = (pkg) => createRequire(path.join(here, "../packages", pkg, "package.json"));
const core = await import(pathToFileURL(path.join(here, "../packages/core/dist/index.js")).href);
const sqlite = await import(pathToFileURL(path.join(here, "../packages/checkpoint-sqlite/dist/index.js")).href);
const { SqliteSaver } = requireFrom("checkpoint-sqlite")("@langchain/langgraph-checkpoint-sqlite");
const { MemorySaver } = requireFrom("checkpoint-sqlite")("@langchain/langgraph");

const runs = Number(process.argv.find((arg, i) => process.argv[i - 1] === "--runs") ?? 2000);
const NOTE = "n".repeat(2048);

core.registerFunction("benchStep", (input) => {
  const body = input ?? {};
  const n = typeof body.n === "number" ? body.n : 0;
  const note = typeof body.note === "string" && body.note.length > 0 ? body.note : NOTE;
  return { n: n + 1, note };
});

const spec = {
  metadata: { name: "checkpoint-growth" },
  state: {
    channels: {
      n: { type: "number" },
      note: { type: "string" },
    },
  },
  nodes: [
    {
      id: "step",
      type: "function",
      with: {
        fn: "benchStep",
        input: { n: "{{ state.n }}", note: "{{ state.note }}" },
        output: { map: { n: "{{ result.n }}", note: "{{ result.note }}" } },
      },
    },
  ],
  edges: [
    { from: "START", to: "step" },
    { from: "step", to: "END" },
  ],
};

function fileBytes(file) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += fs.statSync(file + suffix).size;
    } catch {
      /* sidecar absent */
    }
  }
  return total;
}

async function runThreads(checkpointer, { threads, sameThread }) {
  const compiled = await core.compileGraph(spec, { checkpointer });
  const started = Date.now();
  for (let i = 0; i < runs; i++) {
    const threadId = sameThread ? "thread-1" : `thread-${i}`;
    const result = await compiled.run({ threadId, onInterrupt: "fail" });
    if (result.status !== "completed") {
      throw new Error(`run ${i} on ${threadId} ended ${result.status}: ${result.error ?? ""}`);
    }
  }
  return { elapsedMs: Date.now() - started, threads };
}

async function sqliteCase(label, make) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-growth-"));
  const file = path.join(dir, "checkpoints.db");
  const saver = await make(file);
  const many = await runThreads(saver, { threads: runs, sameThread: false });
  try {
    saver.db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* baseline saver may already be closing */
  }
  const manyStats = sqlite.sqliteCheckpointStats?.(saver.db) ?? null;
  const manyBytes = fileBytes(file);
  try {
    saver.db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dir, { recursive: true, force: true });

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fg-growth-"));
  const file2 = path.join(dir2, "checkpoints.db");
  const saver2 = await make(file2);
  const one = await runThreads(saver2, { threads: 1, sameThread: true });
  try {
    saver2.db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* baseline saver may already be closing */
  }
  const oneStats = sqlite.sqliteCheckpointStats?.(saver2.db) ?? countSqlite(saver2.db);
  const oneBytes = fileBytes(file2);
  try {
    saver2.db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dir2, { recursive: true, force: true });
  return {
    label,
    manyThreads: { ...many, fileBytes: manyBytes, ...(manyStats ?? countSqlite(null)) },
    oneThread: { ...one, fileBytes: oneBytes, ...oneStats },
  };
}

function countSqlite(db) {
  if (!db) return {};
  const one = (sql) => {
    try {
      return db.prepare(sql).get();
    } catch {
      return { n: 0, b: 0 };
    }
  };
  const checkpoints = one("SELECT COUNT(*) AS n, COALESCE(SUM(length(checkpoint)), 0) AS b FROM checkpoints");
  const writes = one("SELECT COUNT(*) AS n, COALESCE(SUM(length(value)), 0) AS b FROM writes");
  return {
    checkpoints: Number(checkpoints?.n ?? 0),
    checkpointBytes: Number(checkpoints?.b ?? 0),
    writes: Number(writes?.n ?? 0),
    writeBytes: Number(writes?.b ?? 0),
  };
}

async function memoryCase(label, make) {
  const manySaver = make();
  const many = await runThreads(manySaver, { threads: runs, sameThread: false });
  const oneSaver = make();
  const one = await runThreads(oneSaver, { threads: 1, sameThread: true });
  const bytes = (saver) => (typeof saver.byteSize === "function" ? saver.byteSize() : roughMemoryBytes(saver));
  return {
    label,
    manyThreads: { ...many, bytes: bytes(manySaver) },
    oneThread: { ...one, bytes: bytes(oneSaver) },
  };
}

function roughMemoryBytes(saver) {
  let n = 0;
  for (const nsMap of Object.values(saver.storage ?? {})) {
    for (const bucket of Object.values(nsMap ?? {})) {
      for (const row of Object.values(bucket ?? {})) {
        if (row?.[0]) n += row[0].byteLength ?? 0;
        if (row?.[1]) n += row[1].byteLength ?? 0;
      }
    }
  }
  for (const group of Object.values(saver.writes ?? {})) {
    for (const entry of Object.values(group ?? {})) {
      if (entry?.[2]) n += entry[2].byteLength ?? 0;
    }
  }
  return n;
}

async function postgresScenario(postgres, url, retention, sameThread) {
  const schema = `fg_bench_${Math.random().toString(36).slice(2, 8)}`;
  const backend = await postgres.openPostgresBackend({
    connectionString: url,
    schema,
    ...(retention !== undefined ? { retention } : {}),
  });
  const pg = requireFrom("checkpoint-postgres")("pg");
  const admin = new pg.Pool({ connectionString: url });
  try {
    const result = await runThreads(backend.checkpointer, { threads: sameThread ? 1 : runs, sameThread });
    const size = await relationBytes(backend.pool, schema);
    return { ...result, ...size };
  } finally {
    await backend.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

async function postgresCase(label, retention) {
  const postgres = await import(pathToFileURL(path.join(here, "../packages/checkpoint-postgres/dist/index.js")).href);
  const url = process.env.FLOWGRAPH_TEST_POSTGRES_URL;
  const many = await postgresScenario(postgres, url, retention, false);
  const one = await postgresScenario(postgres, url, retention, true);
  return { label, manyThreads: many, oneThread: one };
}

async function relationBytes(pool, schema) {
  const result = await pool.query(
    `SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [schema],
  );
  let bytes = 0;
  const tables = {};
  for (const row of result.rows) {
    if (String(row.name).startsWith("fg_memory_")) continue;
    const size = Number(row.bytes);
    tables[row.name] = size;
    bytes += size;
  }
  return { relationBytes: bytes, tables };
}

const report = {
  runs,
  noteBytes: NOTE.length,
  sqlite: {
    baseline: await sqliteCase("sqlite baseline (no retention)", async (file) => SqliteSaver.fromConnString(file)),
    retained: await sqliteCase("sqlite retained (defaults)", async (file) =>
      sqlite.createSqliteCheckpointer({ path: file }),
    ),
  },
  memory: {
    baseline: await memoryCase("memory baseline", () => new MemorySaver()),
    retained: await memoryCase("memory retained (defaults)", () => new core.FlowgraphMemorySaver()),
  },
};

if (process.env.FLOWGRAPH_TEST_POSTGRES_URL) {
  report.postgres = {
    baseline: await postgresCase("postgres baseline", false),
    retained: await postgresCase("postgres retained (defaults)", undefined),
  };
}

console.log(JSON.stringify(report, null, 2));
