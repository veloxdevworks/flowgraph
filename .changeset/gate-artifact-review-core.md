---
"@flowgraph/core": minor
---

Review generated assets at `hitl` gates. `with.artifacts` now flattens Artifacts, media outputs and workspace paths into `artifacts` records and `artifactRefs` (no more `[object Object]`) in approve, choice and review. `with.select` lets the human pick from what was shown; `selected` is validated against the presented artifacts and invalid picks re-prompt. Every gate output gains `round`. Media `with.variant` joins the job fingerprint (never sent to vendors; unchanged fingerprint when unset), so a loop back can force a new vendor call. `workshop` `artifactRefs` get the same flattening. New lint warning `HITL_SELECT_NO_ARTIFACTS`.
