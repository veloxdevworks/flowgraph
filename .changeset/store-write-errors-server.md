---
"@flowgraph/server": patch
---

Graph store failures no longer send the file-system error to clients. A failed write of a thread's graph or meta file (disk full, permissions, an I/O error) answers `503 GRAPH_STORE_WRITE_FAILED`, and a stored graph file that exists but cannot be read answers `503 GRAPH_STORE_READ_FAILED` instead of looking like a missing graph. Both messages name only the thread; the path, errno and stack are logged (`graph store write failed` / `graph store read failed`). Any other failed system call that reaches REST, `/invocations`, the request handler or a connect command answers `500 INTERNAL_ERROR` with no detail, which is logged. Other errors keep their messages and statuses. `GraphStoreError` is exported.
