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

Definite pre-acceptance failures from fetch-based adapters (including missing
credentials and rejected 400/429 requests) clear intent and record zero usage.
Ambiguous failures retain intent. Wait for admitted fanout jobs to settle so
completed outcomes/cost are saved before reporting a sibling failure. Missing
completed artifacts now fail with MEDIA_ARTIFACTS_MISSING instead of repurchasing.
