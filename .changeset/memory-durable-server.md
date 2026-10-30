---
"@flowgraph/server": minor
---

Durable memory behind config: `FLOWGRAPH_MEMORY_BACKEND=postgres` keeps `runtime.memory` in the `DATABASE_URL` database on the checkpointer's pool, `sqlite` in a local file (`FLOWGRAPH_MEMORY_SQLITE_PATH`, needs `@flowgraph/checkpoint-sqlite`). The default (`memory`) is unchanged. Runs write as `FLOWGRAPH_ORG` / `FLOWGRAPH_PROJECT` / `FLOWGRAPH_USER`; expired memory is swept hourly (`FLOWGRAPH_MEMORY_SWEEP_MS`). New `RunService.close()`.
