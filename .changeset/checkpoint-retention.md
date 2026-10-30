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
- Sqlite dedupe writes those rows as serde type `fg-checkpoint-v1` (values in `fg_checkpoint_blobs`). Flowgraph still reads them if dedupe or retention is later turned off. A stock SQLite saver or an older flowgraph fails the read instead of returning empty state. A newer checkpoint schema version is refused at open.
- Opting into thread deletion removes that thread's checkpoints and its `fg_memory_threads` binding. Memory items stay.
- `vacuum: auto` only runs sqlite incremental vacuum. A blocking `VACUUM` is `vacuum: always`.

`retention: false` on a graph keeps that graph's threads intact, including on a shared checkpoint file. The server honors each graph and accepts `FLOWGRAPH_CHECKPOINT_RETENTION` as the host default.
