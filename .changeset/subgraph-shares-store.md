---
"@flowgraph/core": patch
---

`subgraph` nodes now share the parent's long-term store, so `ctx.store` reads and writes inside a child graph see the same data as the parent. A child with `runtime.store.enabled: false` or `backend: none` still gets no store.
