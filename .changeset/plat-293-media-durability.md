---
"@flowgraph/core": minor
"@flowgraph/media": patch
"@flowgraph/cli": minor
---

Persist media submission intent before synchronous or asynchronous vendor calls,
refuse uncertain resubmission, retain handles after best-effort cancellation, and
add explicit media inspection/reconciliation. Validate OpenAI image pixel/edge
limits offline and before submission. Existing accepted/completed journals remain
readable; old runtimes must not operate on journals with unresolved intent records.
