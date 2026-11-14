---
"@flowgraph/checkpoint-sqlite": minor
---

Prune SQLite checkpoints using compact channel-version metadata instead of
repeatedly decoding retained graph states. Schema 7 lazily backfills legacy
rows and preserves concurrent unpublished references. Add a reproducible
retention benchmark and a PostgreSQL reused-database CI gate.
