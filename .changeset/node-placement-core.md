---
"@flowgraph/core": minor
---

Add the node-placement building blocks from ADR-0020: built-in and custom host labels (`detectBuiltinLabels`, `runLabelChecks`, `hostLabels`), topology parsing (`parseTopology`, `resolveTargetToken`), `effectiveRequirements`, the `WorkerTransport` interface, and `resolvePlacements`. `compileGraph` now throws `PlacementUnsatisfiedError` (`PLACEMENT_UNSATISFIED`) for a top-level node with `runsOn` that this host cannot satisfy and that does not set `fallback: local`, instead of ignoring `runsOn`. Remote dispatch is a later slice.
