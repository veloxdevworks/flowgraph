---
"@flowgraph/core": patch
"@flowgraph/spec": patch
---

Subgraph nodes merge child results by an explicit `stateMap.out` (parent channel ← child channel or expression), or by channels that share a name. The parent's reducer combines only the child's new values, so `append` and `merge` no longer replay state the child was seeded with. Parallel subgraph writes merge in node-id order, and a child that interrupts then resumes merges its finished state once. Validate reports `stateMap.out` keys that are not parent channels and values that name a missing child channel.
