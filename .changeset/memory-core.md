---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

Scoped long-term memory. New `runtime.memory` (backend, subject, limits) and a `memory` node (`get | search | put | patch | increment | append | delete`). Code gets `ctx.memory`, a handle pre-bound to the run's org / project / graph / user / subject with atomic increment/patch/append, compare-and-set `update`, replay-safe writes, size/TTL/secret guards and user > subject > graph > project > org read precedence. `ctx.store` is now a graph-scoped view on the same backend, so two graphs no longer see each other's items. `runtime.store.backend: sqlite | postgres` is an alias for `runtime.memory` on the checkpoint database. New `CompileOptions.memory` (`{ backend, identity }`, a `MemoryBackend`, or `"ephemeral"`); `runtime.memory` without a durable host backend is a compile error (`MEMORY_BACKEND_UNAVAILABLE`). `validateSpec` reports memory problems, and `memoryHostDiagnostics` lets hosts flag backends they cannot serve.
