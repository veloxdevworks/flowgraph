---
"@flowgraph/server": patch
---

`RunService.close()` (and SIGTERM / SIGINT shutdown) now waits for every pending graph-store meta write before closing pools and resolving, including the `running` status that resume and continue record without waiting. Before, close could resolve while such a write was still renaming its file into the graph store, so removing the store directory right after close could fail with `ENOTEMPTY`. A failed meta write is logged as `graph meta update failed` and never becomes an unhandled rejection; shutdown waits at most `closeTimeoutMs` (default 5 s) for these writes and logs `shutdown.meta_writes_timeout` if any are still pending.

`cancelRun` and `pauseRun` are refused with `503 SERVER_CLOSING` once `close()` has started, like the other entry points. A call already under way when close starts is waited for, so neither can rewrite a run's stored status after shutdown. Cancelling or pausing a run that has completed now leaves it `completed` and answers with that status, instead of rewriting it to `cancelled` or `paused`. When the wait for meta writes times out, `shutdown.meta_writes_timeout` names the threads still pending.
