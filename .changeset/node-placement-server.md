---
"@flowgraph/server": minor
"@flowgraph/core": minor
---

Worker side of node placement (ADR-0020).

- Server: `GET /worker/labels` returns the labels this server advertises (built-in plus custom labels whose check passes). `POST /worker/preflight` validates and preflights a graph without running it, and creates no run or thread. Custom labels come from `FLOWGRAPH_WORKER_LABELS` and `FLOWGRAPH_WORKER_LABELS_FILE`; labels with a `check` are re-run every `every` (default 10m) and withdrawn while the check fails. Invalid label config fails startup.
- Server: `POST /runs` for a thread id that is running or has a stored run answers 409 with `{ code: "THREAD_EXISTS", threadId, status, active }` instead of starting over it, so a coordinator can reconnect. A thread of another user still answers 403 `THREAD_NOT_OWNED`. A thread whose last run ended in `error` can be started again.
- Core: `createHttpTransport()` implements `WorkerTransport.labels` and `.preflight` against those endpoints with the target's bearer token. `CORE_VERSION` is exported.
