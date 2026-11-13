---
"@flowgraph/core": minor
---

Emit state.update for applied public state changes with post-reducer replacement
values, and edge.taken for selected static, conditional, and command transitions.
Progress flows through existing event sinks, streams, CLI output, and server
SSE/journals. Preserve thread attribution across concurrent runs and forward
nested graph progress with parent scope.
