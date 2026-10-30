---
"@flowgraph/server": patch
---

`ctx.store` on the server is a graph-scoped view over one shared in-process memory backend (capped at 50,000 items), so graphs no longer see each other's keys.
