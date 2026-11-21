---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

A static edge can list two or more sources, `{ from: [a, b], to: join }`. The join runs once, after every listed source finishes, including when the branches have different lengths. A node with plain inbound edges from branches of uneven length warns (`UNEVEN_FAN_IN`). A barrier source that can only be reached through a conditional branch, a router, or a hitl route is an error, as are unknown ids, duplicates, `END`, a barrier that lists its own target, and a listed source that has a recovery route.
