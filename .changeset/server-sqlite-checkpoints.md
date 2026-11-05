---
"@flowgraph/server": minor
---

`FLOWGRAPH_MEMORY_BACKEND=sqlite` without `DATABASE_URL` now also keeps run checkpoints in the sqlite file (`FLOWGRAPH_MEMORY_SQLITE_PATH`, default `<FLOWGRAPH_GRAPH_STORE>/memory.db`), next to the thread owners and graph names already stored there. A run waiting on a human answer can be resumed after the server restarts on the same graph store, for example an AgentCore session whose storage survives an idle stop. Previously checkpoints stayed in process memory and were lost on restart. With `DATABASE_URL` set, checkpoints stay in Postgres as before. No new setting: this backend already counted as durable for the startup auth checks.
