---
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
---

`openSqliteBackend` and `openPostgresBackend` return `threadOwners`, a durable `ThreadOwnerRegistry` stored next to the checkpoints (`createSqliteThreadOwnerRegistry` / `createPostgresThreadOwnerRegistry`). Memory schema 5 adds its table, `fg_thread_owners`; it migrates automatically on open.
