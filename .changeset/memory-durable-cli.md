---
"@flowgraph/cli": minor
---

`flowgraph run` / `resume` keep `runtime.memory` (and `runtime.store.backend: postgres`) in a postgres checkpoint database, sharing one connection pool with the checkpointer; `validate` no longer reports postgres memory as unavailable.
