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
- Pending writes are removed only after a successor checkpoint row is stored, except on interrupt and resume pins. Writes flushed before that row lands are kept, so a later resume still sees the interrupt.
- Opting into thread deletion removes that thread's checkpoints and its `fg_memory_threads` binding. Memory items stay.
- `vacuum: auto` only runs sqlite incremental vacuum. A blocking `VACUUM` is `vacuum: always`.

`retention: false` on a graph keeps that graph's threads intact, including on a shared checkpoint file. The server honors each graph and accepts `FLOWGRAPH_CHECKPOINT_RETENTION` as the host default.
