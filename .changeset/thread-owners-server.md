---
"@flowgraph/server": minor
---

**Breaking for untrusted authors: some uploads that ran before are now refused with a 403.** Agent host tools (`start_service`, `stop_service`, `restart_service`, file tools, other registered function tools; `UPLOAD_AGENT_TOOL_BLOCKED`), `function` / `code` nodes (`UPLOAD_FUNCTION_BLOCKED`), workshop and `hitl` review `diff` with `cwd` / `base` / `paths` (`UPLOAD_HOST_PATH_BLOCKED`), `runtime.services.rehydrateOnResume` and `runtime.worktrees.cleanupOnEnd` (`UPLOAD_RUNTIME_HOST_EXEC_BLOCKED`), and declaring, writing or defaulting `__*` engine state channels (`UPLOAD_RESERVED_CHANNEL_BLOCKED`). To keep such a graph: drop the tool or list it in `FLOWGRAPH_UNTRUSTED_ALLOW_TOOLS`, list safe functions in `FLOWGRAPH_UNTRUSTED_ALLOW_FUNCTIONS`, pass `diff: { before, after }` text, remove the runtime flags, rename the channel, or have a trusted author run it. For every caller, run `input` that sets `__services`, `__worktrees`, `__agentReplay` or another `__*` engine channel is a 403 `RESERVED_CHANNEL_BLOCKED`.

Thread owners are stored next to the checkpoints (Postgres with `DATABASE_URL`, else the sqlite memory file, else process memory), so replicas sharing a database agree on who owns a thread and a wiped graph store no longer hands a thread to the next caller. On startup a multi-user server copies owners from its graph store's meta files into that store (idempotent), so threads from before the upgrade keep their owners on every replica once each replica with its own graph store has started; `RunService.backfillThreadOwners()` runs the same pass on demand. A thread with saved checkpoints but no recorded owner is refused, and a failed owner lookup is a 503 `THREAD_OWNER_UNAVAILABLE`. With `DATABASE_URL` set, graph names are shared through Postgres too. A thread id that collides on disk with another user's thread is a 403 that does not name it.

Untrusted graphs' outbound requests are capped at 30 s and 10 MiB.

A discovered `jwks_uri` must be https or on the issuer's origin, and a failed discovery is retried after 5 s rather than on every request. Shutdown waits at most `closeTimeoutMs` (default 5 s) for each pool to close.
