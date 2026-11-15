---
"@flowgraph/core": patch
"@flowgraph/cli": patch
---

Stop owned service process trees and wait for confirmed shutdown, escalating when descendants ignore the stop signal. Reject changed same-name starts with SERVICE_START_CONFLICT instead of silently reusing a process with stale arguments.

Handle terminal hangups during execution and webhook waits, cleaning detached service groups. Return service-start conflicts to agents as recoverable tool errors.
