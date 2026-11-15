---
"@flowgraph/checkpoint-sqlite": minor
---

Store growing checkpoint state and pending writes in shared, content-defined chunks with atomic references, hash validation and indexed garbage collection. Preserve full history independently of retention. Upgrade the SQLite checkpoint schema to version 8.
