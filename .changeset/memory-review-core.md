---
"@flowgraph/core": minor
---

Memory hardening from review: op-id replay dedupe now also checks a fingerprint of the write (scope, key, op, arguments), so a retry that makes a different write is applied instead of dropped. Thread bindings are insert-only and record the principal id; `resume`/`continue` (and `start` on an existing thread id) under a different org, project, graph, user, principal or subject fail with `MEMORY_SCOPE_MISMATCH`. Recall blocks JSON-encode keys and escape `<`, `>` and look-alikes after NFKC normalization; keys with control characters are rejected. New `legacyStoreBackend` compile option gives `ctx.store` a graph-scoped view over a shared backend. `createInMemoryMemoryBackend({ maxItems })` caps total items (default 100,000). New `MEMORY_AGENT_WRITES_WIDE` lint warning; memory nodes fail on an empty key instead of writing `"undefined"`; raw subject keys may not start with `sha256:`.
