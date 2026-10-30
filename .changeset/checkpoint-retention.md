---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
"@flowgraph/cli": patch
"@flowgraph/server": patch
---

Checkpoint storage is bounded. Each thread keeps its newest checkpoints (default 40 per namespace) plus interrupt and resume points, and finished threads are deleted after 14 days or past 200 threads. Paused threads are kept, so resume still works. Sqlite and the in-memory saver store each channel version once; Postgres drops blob versions nothing references. Configure it with `runtime.checkpoint.retention` or the checkpointer host options. `retention: false` keeps the full history. Durable memory tables are unchanged.
