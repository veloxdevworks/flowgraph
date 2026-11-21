---
"@flowgraph/core": minor
---

A conditional edge whose `when` guard throws at run time now fails the run with error code `EDGE_GUARD_ERROR` instead of falling through to the `default` branch or `END`. The error names the edge (`from` -> `to`) and the expression, and the run records an `EDGE_GUARD_ERROR` issue with severity `error`. A guard that evaluates to false still takes the next entry or the default. The same applies to branch edges leaving a node that has a recovery route (`on.error: route:<id>` or a routing hook).

Migration: a graph that relied on a broken guard silently ending the run now ends with status `error`. Fix the expression, or test for missing values explicitly. Missing paths already evaluate to null and are not errors.
