---
"@flowgraph/core": minor
"@flowgraph/spec": minor
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
"@flowgraph/cli": patch
"@flowgraph/server": patch
---

Checkpoint history is bounded per branch. Each thread this process runs keeps its newest checkpoints (default 40 on each branch) plus interrupt and resume points. Channel values are stored once per version. Deleting a finished thread is opt-in (`finishedTtl` or `maxFinishedThreads`); the default keeps every thread. Paused, interrupted, aborted, and errored threads are never deleted. Threads the saver did not record are not swept.

Data-affecting behavior:

- Threads run with retention on lose checkpoints outside the per-branch window and the pinned interrupt points.
- Sqlite keeps channel values in the checkpoint row until a value larger than 4 KB is repeated. Repeated large values are stored once in `fg_checkpoint_blobs` and the row is stamped `fg-checkpoint-v1`. Flowgraph still reads those rows if dedupe or retention is later turned off. A stock SQLite saver or an older flowgraph fails that read instead of returning empty state. A newer checkpoint schema version is refused at open.
- Pending writes are removed only after a successor checkpoint row is stored, except on interrupt and resume pins. Writes flushed before that row lands are kept, so a later resume still sees the interrupt. Prune deletes writes and pins only for checkpoint ids it listed and chose to drop.
- `maxCheckpoints` must be a positive integer and `maxInterruptPoints` a non-negative integer, at most `Number.MAX_SAFE_INTEGER`. A string such as `"40"` is rejected. Resuming a checkpoint id that is not stored returns `CHECKPOINT_PRUNED`. When retention is on, the message says the checkpoint is missing or was pruned. The call does not mark the thread paused. A run that stops before it starts restores the earlier saved status and releases its guard token. A sweep skips a thread this process has in flight or parked. A resumed run releases its earlier park, so a thread that pauses more than once can still be swept after it finishes. On a shared database the sweep deletes only if the thread is still that finished record, and it retries a Postgres deadlock. The run marks the thread active before it reads state. If the process stops after that mark and before the checkpoint row is written, the thread stays active until a later run or `deleteThread`. `deleteThread()` always deletes.
- Opting into thread deletion removes that thread's checkpoints and its `fg_memory_threads` binding. Memory items, memory replay records (`fg_memory_ops`), and the thread owner (`fg_thread_owners`) stay. Interrupt checkpoints keep the agent replay snapshot on their pending writes.
- `vacuum: auto` only runs sqlite incremental vacuum. A blocking `VACUUM` is `vacuum: always`.

`retention: false` on a graph keeps that graph's threads intact, including on a shared checkpoint file. The server honors each graph and accepts `FLOWGRAPH_CHECKPOINT_RETENTION` as the host default.
