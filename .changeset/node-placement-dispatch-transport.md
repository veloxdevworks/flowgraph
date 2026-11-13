---
"@flowgraph/core": minor
"@flowgraph/server": minor
---

Direct transport for node placement (ADR-0020): `createHttpTransport()` now implements `dispatch`, `attach`, `resume` and `cancel` against the worker's existing REST and SSE routes. `dispatch` returns `{ status: "started" }` or `{ status: "exists", runStatus, active }` (on 409 `THREAD_EXISTS`). `attach` returns `{ events, result }`: an event stream that ends at the terminal event, reconnects with `afterSeq` and drops duplicates, plus a `WorkerOutcome` (`completed` / `interrupted` / `error` / `cancelled`, with final `state`, `error` or `interrupts`). `cancel` is idempotent. The `WorkerTransport` payload types changed accordingly (`DispatchResult`, `WorkerOutcome`, `AttachOptions`; `WorkerRunResult` is replaced by `WorkerOutcome`). Server: `GET /runs/:id/events?afterSeq=-1` now replays the whole buffered run, including seq 0.
