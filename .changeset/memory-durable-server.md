---
"@flowgraph/server": minor
---

Durable memory behind config: `FLOWGRAPH_MEMORY_BACKEND=postgres` keeps `runtime.memory` in the `DATABASE_URL` database on the checkpointer's pool, `sqlite` in a local file (`FLOWGRAPH_MEMORY_SQLITE_PATH`, needs `@flowgraph/checkpoint-sqlite`). The default (`memory`) is unchanged. Runs write as `FLOWGRAPH_ORG` / `FLOWGRAPH_PROJECT` (default `local`) / `FLOWGRAPH_USER`; a durable backend without `FLOWGRAPH_ORG` refuses to start. On the default backend, a `runtime.memory` graph's error now points to `FLOWGRAPH_MEMORY_BACKEND`. Expired memory is swept hourly (`FLOWGRAPH_MEMORY_SWEEP_MS`, 1000 to 2147483647 ms; any other value stops startup), by one replica per interval on Postgres. With several replicas use `postgres`: sqlite memory is a file per replica. New `RunService.close()`. Local use with the CLI needs none of this.
