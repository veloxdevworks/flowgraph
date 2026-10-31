---
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
---

`openSqliteBackend` and `openPostgresBackend` return `graphNames`, a durable `GraphNameRegistry` in the memory database (`createSqliteGraphNameRegistry` / `createPostgresGraphNameRegistry`). Memory schema 4 adds its table, `fg_graph_names`; it migrates automatically on open.
