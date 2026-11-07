---
"@flowgraph/core": minor
---

A node `timeout` now stops a `demo` capture instead of only ceasing to wait for it: the browser or recorder closes, and a retry waits up to 20 seconds for that before it starts, so two captures don't overlap.

- Node types opt in with `capabilities.stopsOnTimeout`, which gives them a per-attempt `ctx.signal` that also aborts on timeout (`isTimeoutError(signal.reason)`). Every other node type keeps the run's signal and behaves as before, so a timed-out media job is not cancelled and a retry can re-attach to it.
- Nothing retries once the run is cancelled, and no `node.retry` event follows a cancel.
- With a signal, `demo` turns off Playwright's own SIGINT and SIGTERM handlers. They closed the browser and exited the process before the abort could clean up.
