---
"@flowgraph/core": minor
---

A node `timeout` now stops the attempt instead of only ceasing to wait for it. Each attempt gets its own `ctx.signal`, which aborts on timeout (`isTimeoutError(signal.reason)`) or when the run is cancelled, so a timed-out `demo` capture closes its browser or recorder and a timed-out `shell` or `script` command is killed.

- A retry of a side-effecting node waits up to 20 seconds for the timed-out attempt to stop, so the two don't overlap.
- Nothing retries once the run is cancelled, and no `node.retry` event follows a cancel.
- With a signal, `demo` turns off Playwright's own SIGINT and SIGTERM handlers. They closed the browser and exited the process before the abort could clean up.
