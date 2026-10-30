---
"@flowgraph/core": minor
---

Memory write replay ids are derived from the write (scope, key, operation, canonical arguments) and how many times that write has already run in the node attempt, so a retry that reorders, adds, or drops writes does not apply an earlier increment or append again. `ctx.memory` writes accept an optional `idempotencyKey`; the first payload for that key in the attempt is the one a retry returns. Op records written by older builds (positional ids, including the `opId~fingerprint` alternate) are still deduped on resume. Rows with a null fingerprint do not match.
