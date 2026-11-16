---
"@flowgraph/core": minor
---

A node's result in `state.outputs.<nodeId>` is replaced on every run instead of deep-merged into the previous one.

**BREAKING:**

- The auto-declared `outputs` channel now uses a shallow `merge` keyed by node id. A node that returned `{ count: 1, approved: true }` and then `{ count: 2 }` used to leave `{ count: 2, approved: true }`; it now leaves `{ count: 2 }`. The same applies to `map` collects, subgraph results and `outputs` written back through `stateMap.out`. Downstream expressions that relied on a field surviving from an earlier run must read it from a channel that keeps it (for example `output.map` into a `merge` or `append` channel).
- A graph that declares its own `outputs` channel keeps the reducer it declares, so `outputs: { type: object, reducer: mergeDeep }` restores the old behavior.
- `isOutputNone` recognizes only `"none"`; the `{ none: true }` form is rejected by the schema.

New:

- `output: { to | map, raw: false }` keeps only the projections, so large or sensitive results are not stored in state or checkpoints. `keepsRawOutput(output)` tells whether a mapping writes `state.outputs.<nodeId>`.

Existing checkpoints load unchanged; only how later writes combine is different.
