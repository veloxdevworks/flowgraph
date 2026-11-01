---
"@flowgraph/server": patch
---

The server sweeps its graph store at startup and every `FLOWGRAPH_GRAPH_STORE_SWEEP_INTERVAL_MS` (default 1 hour; `0` for startup only). Temporary files that a crashed writer left behind are removed once they are older than `FLOWGRAPH_GRAPH_STORE_SWEEP_AGE_MS` (default 1 hour, at least 1 minute). A thread whose create stopped after its meta file was written but before its graph was stored no longer lists as `running` forever: `GET /runs` leaves it out while it is younger than the sweep age and lists it as `error` after that. Its meta file is kept, so the thread id stays its owner's, and the owner's next upload stores the graph. `ServerConfig.graphStoreSweep` sets both values for embedders. `RunService` takes an optional second argument (`now`, `graphStoreHooks`), and `graphStoreHooks` is no longer a module-level export of `graph-source`; pass hooks to `persistGraph` instead.
