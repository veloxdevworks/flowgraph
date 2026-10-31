---
"@flowgraph/expr": minor
---

**Breaking:** `state` in an expression leaves out top-level keys starting with `__` (the engine's own channels), however it is read: `state.__x`, `state['_' + '_x']`, `{{ state }}` and `keys(state)`. Other scope roots and `__` keys nested inside a channel are unchanged. New export `HIDDEN_STATE_PREFIX`.
