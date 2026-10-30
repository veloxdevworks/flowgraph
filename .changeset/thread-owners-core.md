---
"@flowgraph/core": minor
---

New `ThreadOwnerRegistry` interface (`claim`, first claimant of a thread id owns it; `get`) with `createInMemoryThreadOwnerRegistry`. The node policy gains `allowedTools` (agent function tools and builtins mapped onto them, `TOOL_BLOCKED`), `allowedFunctions` (`function` / `code` nodes, `FUNCTION_BLOCKED`) and `blockHostExec` (workshop `git diff`, `HOST_EXEC_BLOCKED`), checked when the graph is built and again when it runs; the service tools refuse to start, stop or restart anything when the policy blocks `service` nodes. `guardedFetch` stops at `maxResponseBytes` (default 10 MiB, `OUTBOUND_RESPONSE_TOO_LARGE`) and `timeoutMs` (default 30 s, `OUTBOUND_TIMEOUT`).
