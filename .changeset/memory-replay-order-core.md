---
"@flowgraph/core": minor
---

Memory write replay ids are derived from the write (scope, key, operation, canonical arguments) and how many times that write has already run in the node attempt, so a retry that reorders, adds, or drops writes does not apply an earlier increment or append again. `ctx.memory` writes accept an optional `idempotencyKey` bound to the kind, scope and memory key; the first payload for that operation is the one a retry returns, and reusing the key for a different operation fails with `MEMORY_IDEMPOTENCY_CONFLICT`. Op records written by older builds (positional ids, including the `opId~fingerprint` alternate) are still deduped on resume. Rows with a null fingerprint do not match. A top-level node keeps its id. A node under another node includes that path, and each tool call uses its own path (`tool:<n>` under the caller), so a resume that skips a cached call still matches the call that runs again.
