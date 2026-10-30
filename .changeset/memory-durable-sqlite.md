---
"@flowgraph/checkpoint-sqlite": minor
---

Memory schema migration 3 adds a covering index for the per-type subject cap and cross-subject search, so neither scans every item, and renames `fg_threads` / `fg_meta` to `fg_memory_threads` / `fg_memory_meta`. Back up the `.db` file before upgrading; migrations are forward-only. `sweep` takes a replay-record retention.
