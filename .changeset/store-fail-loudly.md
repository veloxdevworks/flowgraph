---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

Long-term store no longer falls back silently. `runtime.store.backend: sqlite | postgres` without an injected `CompileOptions.store` instance now throws at compile time instead of quietly using a process-local `InMemoryStore`. `runtime.checkpoint.backend` and `runtime.store.backend` are now enums (`memory | sqlite | postgres` and `memory | none | sqlite | postgres`); other values are load-time schema errors.
