---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
---

Abandoned active threads are swept. A run marks its thread `active` before it reads state; if the process stopped mid-run, that row stayed active and finished-thread deletion never removed it. A new retention option, `activeTtl` (default `7d`, a duration or milliseconds, `null` to turn it off), applies when `finishedTtl` or `maxFinishedThreads` is set: a sweep treats an active row whose last activity is older than `activeTtl` as a finished thread as of that activity, and `finishedTtl` and `maxFinishedThreads` then decide when it is deleted.

- Activity is the run's active mark and every checkpoint it writes. There is no heartbeat. A run that keeps checkpointing is never abandoned. A single step on another host that runs longer than `activeTtl` without a checkpoint looks the same as a crash; keep `activeTtl` well above your longest step.
- A sweep never reclaims a run its own process is running. A run waiting in process for an answer (`resolveInterrupt` at a node interrupt or a breakpoint) stores its row `paused` under its own mark, so another host never reclaims it, and sets it back to `active` under that mark when the answer comes. A process that stops while waiting leaves the row `paused`: never deleted by retention, and resumable. The sweep updates a row only if it is unchanged since it was listed, so a run that marked or checkpointed in between keeps it.
- A checkpoint write keeps the current active mark instead of clearing it, and a restore matches both the mark and its time, so a run that stopped and wakes later cannot undo a newer run's mark or roll back a row written since.
- Continuing past a breakpoint in process with `resolveInterrupt` now runs the next node. It previously failed with `Received empty Command input`.
- The row records the run's `activeTtl`, `finishedTtl`, and `maxFinishedThreads`, so another host on a shared database applies the graph's policy. Checkpoint schema 4 adds `active_ttl_ms` to `fg_checkpoint_threads` on sqlite and Postgres. Active rows written before it use the sweeping host's policy. Schema 4 also adds a partial index on active rows, and the sweep lists only active rows past their limit. An older flowgraph refuses to open a database at schema 4; one that already had it open keeps working. Until every host is upgraded, an old host's in-process wait keeps its row `active`.
- The Postgres active-mark advisory lock key now includes the schema (`activeMarkLockKey(schema, threadId)`), so savers on different schemas of one database no longer wait on each other.
- `FlowgraphMemorySaver`, `FlowgraphSqliteSaver`, and `FlowgraphPostgresSaver` accept an optional `clock` for tests, and `openSqliteBackend`, `createSqliteCheckpointer`, `openPostgresBackend`, and `createPostgresCheckpointer` pass it through.
