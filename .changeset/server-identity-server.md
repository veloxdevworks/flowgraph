---
"@flowgraph/server": minor
---

Per-caller identity with OIDC. Set `FLOWGRAPH_OIDC_ISSUER` and `FLOWGRAPH_OIDC_AUDIENCE` and every REST, SSE, AgentCore `/invocations` and connect request must carry a JWT from that issuer (discovery, cached JWKS with rotation, RS256/ES256 by default, `exp`/`nbf`/`iat` with `FLOWGRAPH_OIDC_CLOCK_SKEW_SECONDS`, `aud`/`iss`; claim names configurable). Each caller is then its own principal: a thread belongs to whoever started it (403 `THREAD_NOT_OWNED` for anyone else, `GET /runs` lists only your own), memory is written as and resumable only by that caller, and a graph name belongs to the first caller in an org to upload it (409 `GRAPH_NAME_TAKEN`, kept in the sqlite/postgres memory database). Over connect, each command carries the end user's JWT as `params.accessToken`; the relay itself is trusted with every thread's events (see the README trust model).

Graphs from untrusted authors (callers outside `FLOWGRAPH_OIDC_TRUSTED_ROLES` / `FLOWGRAPH_OIDC_TRUSTED_TEAMS`) cannot use shell, script, service, worktree, skill, demo or mcp nodes, `mcpServers`, agent MCP tools, `localTools`, `requires`, file subgraphs, `${VAR}` or `secrets.*`, host paths, the `ollama` vendor, or provider endpoint and key overrides (403 `UPLOAD_*`, checked at upload and again at run). Their `http` and `webhook` nodes reach public addresses only: every resolved address and every redirect hop is checked, and loopback, private, link-local, CGNAT and cloud metadata targets (IPv4 and IPv6) are refused. `FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS` lists inner hosts they may still reach (never metadata or link-local).

Uploaded YAML is stored, kept in the session and returned by `GET /runs/:id` as written; `${VAR}` placeholders in trusted graphs are filled at run time only, so environment values are never persisted. Files from older servers are not expanded again.

`RunService.close()` (and SIGTERM) now refuses new runs with 503 `SERVER_CLOSING`, waits up to `FLOWGRAPH_SHUTDOWN_TIMEOUT_MS` (default 10 s) for runs in flight, aborts the rest, and only then closes database pools. A start whose graph fails to compile no longer leaves a running placeholder. Auth failures are `{ error, code }` with `AUTH_REQUIRED`, `AUTH_INVALID_TOKEN`, `AUTH_TOKEN_EXPIRED`, `AUTH_NO_ORG` or `AUTH_PROVIDER_UNAVAILABLE`. New `FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS`.

**BREAKING:**

- **Token mode must be explicit on durable servers.** With `DATABASE_URL` or `FLOWGRAPH_MEMORY_BACKEND=postgres|sqlite`, a server with only `FLOWGRAPH_AUTH_TOKEN` refuses to start; add `FLOWGRAPH_AUTH_MODE=token` (single shared principal) or use OIDC. `FLOWGRAPH_AUTH_DISABLED=1` on a durable server refuses to start unless `FLOWGRAPH_INSECURE_DEV=1`.
- **`FLOWGRAPH_AUTH_DISABLED=1` needs `FLOWGRAPH_INSECURE_DEV=1` for shell nodes.** Without it, auth-disabled callers are untrusted authors on every server, so graphs with shell, script, service, worktree, skill, demo or mcp nodes, MCP servers, local tools, `requires`, `${VAR}`, `secrets.*`, ollama, or `http` calls to local addresses are refused with 403. Set `FLOWGRAPH_INSECURE_DEV=1` on a local dev server, or use token mode.
- Reusing a thread id for a different graph is a 409 `THREAD_ID_CONFLICT`.

The `flowgraph` CLI runs graphs locally and is unaffected.
