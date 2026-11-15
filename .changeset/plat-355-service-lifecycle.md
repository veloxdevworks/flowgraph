---
"@flowgraph/core": patch
---

Stop owned service process trees and wait for confirmed shutdown, escalating when descendants ignore the stop signal. Reject changed same-name starts with SERVICE_START_CONFLICT instead of silently reusing a process with stale arguments.
