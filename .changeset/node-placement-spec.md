---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

Add the optional node field `runsOn` (label list or `{ labels, target, fallback, wait }`) with `PLACEMENT_LABEL_PATTERN`, `normalizeRunsOn` and the `RunsOn` / `NormalizedRunsOn` types. `loadGraph` and `validateSpec` now report `PLACEMENT_NOT_ALLOWED`, `PLACEMENT_NESTED` and the warning `PLACEMENT_ADJACENT_HOPS`. The engine validates the field only; running placed nodes on other machines is ADR-0020 work.
