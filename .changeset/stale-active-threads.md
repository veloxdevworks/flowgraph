---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
---

Abandoned active threads are swept. A run marks its thread `active` before it reads state; if the process stopped mid-run, that row stayed active and finished-thread deletion never removed it. A new retention option, `activeTtl` (default `7d`, a duration or milliseconds, `null` to turn it off), applies when `finishedTtl` or `maxFinishedThreads` is set: a sweep treats an active row whose last activity is older than `activeTtl` as a finished thread as of that activity, and `finishedTtl` and `maxFinishedThreads` then decide when it is deleted.

- Activity is the run's active mark and every checkpoint it writes. There is no heartbeat. A run that keeps checkpointing is never abandoned. A single step on another host that runs longer than `activeTtl` without a checkpoint looks the same as a crash; keep `activeTtl` well above your longest step.
- A thread this process is running or has parked is never treated as abandoned. The sweep updates the row only if it is unchanged since it was listed, so a run that marked or checkpointed in between keeps it.
- A checkpoint write keeps the current active mark instead of clearing it, so a run that stopped and wakes later cannot undo a newer run's mark.
- The row records the run's `activeTtl`, `finishedTtl`, and `maxFinishedThreads`, so another host on a shared database applies the graph's policy. Checkpoint schema 4 adds `active_ttl_ms` to `fg_checkpoint_threads` on sqlite and Postgres. Active rows written before it use the sweeping host's policy. An older flowgraph refuses a database at schema 4.
- The Postgres active-mark advisory lock key now includes the schema (`activeMarkLockKey(schema, threadId)`), so savers on different schemas of one database no longer wait on each other.
- `FlowgraphMemorySaver`, `FlowgraphSqliteSaver`, and `FlowgraphPostgresSaver` accept an optional `clock` for tests.
