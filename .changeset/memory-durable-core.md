---
"@flowgraph/core": minor
---

New `startMemorySweeper(backend, { intervalMs, opsRetentionMs })` deletes expired memory and old replay records on a timer, and `MemoryBackend.sweep(now, { opsRetentionMs })` takes the replay-record retention (default 30 days). `AsyncEngineMemoryBackend` and `applyMemoryWriteAsync` run the shared write engine over promise-based tables, for network databases. The per-type subject cap now evicts every subject beyond the cap, oldest first, instead of one at a time. The missing-memory-backend compile error for a postgres checkpointer now points to `openPostgresBackend`.
