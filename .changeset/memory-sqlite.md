---
"@flowgraph/checkpoint-sqlite": minor
---

`openSqliteBackend(path)` returns a checkpointer and a durable memory backend that share one sqlite file (WAL, busy timeout, forward-only `fg_memory_*` migrations, periodic sweep of expired items and old op ids). `createSqliteCheckpointer` is unchanged.
