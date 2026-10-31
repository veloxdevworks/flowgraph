---
"@flowgraph/server": patch
---

A thread whose meta file exists but cannot be read or parsed is refused with `503 THREAD_META_UNREADABLE` instead of being treated as a thread that was never stored, which skipped its owner check. Only a missing file means no stored thread. `listPersistedGraphs` leaves such files out and reports them through a new `onUnreadable` option, and `backfillThreadOwners` counts them as `unreadable` rather than as threads without an owner. `readGraphMeta` now throws `GraphMetaUnreadableError` (exported) for these files, and `readPersistedGraphYaml` and `loadPersistedGraph` pass it on.
