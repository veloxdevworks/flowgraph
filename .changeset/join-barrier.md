---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

A static edge can list several sources, `{ from: [a, b], to: join }`. The join runs once, after every listed source finishes, including when the branches have different lengths. A node with plain inbound edges from branches of uneven length warns (`UNEVEN_FAN_IN`). A barrier source that can only be reached through a conditional branch is an error, as are unknown or duplicate ids in `from`.
