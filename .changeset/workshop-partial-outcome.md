---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/workshop-session": minor
---

A `workshop` session can now end without losing its work. The `finish` facilitator tool checks the draft against the schema, and when it falls short the session stays open with an error naming what is missing, so the facilitator can ask for it. `with.allowPartial` accepts an unfinished output when `endedReason` is `human_ended`, `timeout` or `skipped`; property types are still checked. The node now also writes `complete`, so a graph can route on it. Without `allowPartial`, nothing changes about what the engine accepts.

`@flowgraph/spec` exports `checkWorkshopOutput`, the rule the engine and clients share, along with `validateJsonSchema`, which moved there from `@flowgraph/core`. `applyFacilitatorTool` takes the schema as a new optional argument; without it, `finish` is not checked.
