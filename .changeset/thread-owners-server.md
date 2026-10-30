---
"@flowgraph/server": minor
---

Thread owners are stored next to the checkpoints (Postgres with `DATABASE_URL`, else the sqlite memory file, else process memory), so replicas sharing a database agree on who owns a thread and a wiped graph store no longer hands a thread to the next caller. A thread with saved checkpoints but no recorded owner is refused, and a failed owner lookup is a 503 `THREAD_OWNER_UNAVAILABLE`. With `DATABASE_URL` set, graph names are shared through Postgres too. A thread id that collides on disk with another user's thread is a 403 that does not name it.

Untrusted graphs may no longer give agents host tools (`start_service`, `stop_service`, `restart_service`, file tools and other registered function tools; 403 `UPLOAD_AGENT_TOOL_BLOCKED`), call registered functions from `function` / `code` nodes (`UPLOAD_FUNCTION_BLOCKED`), or run a workshop `git diff` on the server. `FLOWGRAPH_UNTRUSTED_ALLOW_TOOLS` and `FLOWGRAPH_UNTRUSTED_ALLOW_FUNCTIONS` list exceptions. Their outbound requests are capped at 30 s and 10 MiB.

A discovered `jwks_uri` must be https or on the issuer's origin, and a failed discovery is retried after 5 s rather than on every request. Shutdown waits at most `closeTimeoutMs` (default 5 s) for each pool to close.
