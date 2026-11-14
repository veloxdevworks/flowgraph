---
"@flowgraph/core": patch
"@flowgraph/cli": patch
---

Preserve all map and fan-out work at concurrency one, enforce map-local and per-invocation runtime limits without throttling unrelated branches, and collect results separately for each map entry. Apply inner output projections after execution, honor inner retry/timeout settings, and assign stable item IDs to media jobs. Retain legacy checkpoint bags and report author node names in public map snapshots, breakpoint payloads, and step events.
