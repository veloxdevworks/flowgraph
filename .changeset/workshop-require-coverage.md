---
"@flowgraph/core": minor
"@flowgraph/spec": minor
---

`workshop` nodes can require that the whole agenda was covered. With `with.requireCoverage: true`, a `completed` resume that leaves an agenda item uncovered is rejected and re-prompted with a `validationError` naming the uncovered items. An early end accepted by `allowPartial` is exempt. The flag is also sent on the interrupt contract (`WorkshopContract.requireCoverage`), and `checkWorkshopOutput` takes `agenda`, `coverage` and `requireCoverage` so clients can apply the same rule. `with.transcript: omit` leaves `transcript` out of the node result and the `node.output` event. See ADR-0018.

**What to change:** nothing for existing graphs. Both options are opt-in, and the default (`transcript: keep`, no coverage requirement) behaves as before.
