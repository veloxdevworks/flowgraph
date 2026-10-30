---
"@flowgraph/checkpoint-postgres": minor
---

Durable scoped memory on Postgres. `openPostgresBackend(url | { connectionString, pool, schema })` returns the checkpointer and a memory backend over one connection pool, in one schema. Memory migrations are forward-only and run in one transaction under an advisory lock, so hosts starting together are safe; a schema migrated by a newer flowgraph is refused. Writes take advisory locks on their scope and op id and read rows `FOR UPDATE`, so increments, appends, compare-and-set, the per-type subject cap and op-id dedupe are atomic across hosts. Also exports `createPostgresMemoryBackend`, `migratePostgresMemorySchema` and `maybeSweepPostgres`. Adds a `pg` dependency.
