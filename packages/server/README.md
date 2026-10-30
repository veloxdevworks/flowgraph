# `@flowgraph/server`

HTTP run server for hosted flowgraph execution. One ARM64 container serves:

- **Generic REST + SSE** — for ECS/Fargate behind an ALB (desktop remote transport)
- **Bedrock AgentCore Runtime** — `GET /ping` + `POST /invocations`

## Quick start (local)

```bash
pnpm --filter @flowgraph/server build
FLOWGRAPH_AUTH_TOKEN=dev \
FLOWGRAPH_GRAPH_STORE="$HOME/flowgraph-graphs" \
node packages/server/dist/bin.js
```

```bash
# Health (includes process identity: version, node, hostname, graphStoreDir)
curl -s -H "Authorization: Bearer dev" http://127.0.0.1:8080/healthz

# AgentCore ping
curl -s http://127.0.0.1:8080/ping

# Start a run
curl -s -X POST http://127.0.0.1:8080/runs \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -d '{"threadId":"t1","yaml":"...","input":{"text":"hi"}}'

# Live events (SSE)
curl -N -H "Authorization: Bearer dev" \
  http://127.0.0.1:8080/runs/t1/events
```

## Auth

The server identifies callers in one of three modes. None of this applies to the `flowgraph` CLI, which runs locally and never needs a server or an identity.

| Mode | Set by | Who is the caller |
|---|---|---|
| `oidc` | `FLOWGRAPH_OIDC_ISSUER` + `FLOWGRAPH_OIDC_AUDIENCE` | The subject of a verified JWT (`Authorization: Bearer <jwt>`). Each person or service is its own principal. Use this for any shared server. |
| `token` | `FLOWGRAPH_AUTH_TOKEN` | Single-user mode: anyone with the shared token is the same principal. With durable runs or memory (`DATABASE_URL` or a durable `FLOWGRAPH_MEMORY_BACKEND`) the server only starts when you also set `FLOWGRAPH_AUTH_MODE=token`. |
| `none` | `FLOWGRAPH_AUTH_DISABLED=1` | No auth, local/dev only. With durable runs or memory the server refuses to start unless `FLOWGRAPH_INSECURE_DEV=1`. |

`FLOWGRAPH_OIDC_ISSUER` cannot be combined with `FLOWGRAPH_AUTH_TOKEN` or `FLOWGRAPH_AUTH_DISABLED`; `FLOWGRAPH_AUTH_MODE` (`oidc` \| `token` \| `none`) must match the variables that are set. AgentCore `/ping` is always open; `/invocations` skips bearer auth in `token` and `none` mode (SigV4 at the edge) but needs a JWT in `oidc` mode. Over the connect channel, `oidc` mode needs the user's JWT in each command's `params.accessToken`.

### OIDC

The server reads `<issuer>/.well-known/openid-configuration` once, checks that its `issuer` matches, and caches the issuer's JWKS (refetched when a token names an unknown `kid`, at most every 30 s, so key rotation needs no restart). Tokens must be signed with an allowed algorithm (RS256 / ES256 by default; `none` and HS* are refused unless HS* is configured with a shared secret), carry the configured `aud` and `iss`, and be inside `exp` / `nbf` / `iat` give or take the clock skew.

| Env | Default | Purpose |
|---|---|---|
| `FLOWGRAPH_OIDC_ISSUER` | _(unset)_ | Issuer URL; turns on `oidc` mode. Must be `https` (except with `FLOWGRAPH_INSECURE_DEV=1`) |
| `FLOWGRAPH_OIDC_AUDIENCE` | _(required)_ | Comma-separated accepted `aud` values |
| `FLOWGRAPH_OIDC_JWKS_URI` | from discovery | Skip discovery and read keys from this URL |
| `FLOWGRAPH_OIDC_ALGORITHMS` | `RS256,ES256` | Allowed signing algorithms. `HS256`/`HS384`/`HS512` only alone and with `FLOWGRAPH_OIDC_SHARED_SECRET` (32+ bytes) |
| `FLOWGRAPH_OIDC_CLOCK_SKEW_SECONDS` | `60` | Tolerance for `exp` / `nbf` / `iat`, 0 to 300 |
| `FLOWGRAPH_OIDC_ORG_CLAIM` | `org_id` | Claim holding the caller's org. Without it the caller gets `FLOWGRAPH_ORG`, or a 403 `AUTH_NO_ORG` when that is unset |
| `FLOWGRAPH_OIDC_PROJECT_CLAIM` | _(unset)_ | Claim holding the memory project; otherwise `FLOWGRAPH_PROJECT` (default `local`) |
| `FLOWGRAPH_OIDC_ROLES_CLAIM` / `FLOWGRAPH_OIDC_TEAMS_CLAIM` | `roles` / `groups` | Claims read as the caller's roles and teams |
| `FLOWGRAPH_OIDC_NAME_CLAIMS` | `name,preferred_username,email` | First present claim is the display name (logs only) |
| `FLOWGRAPH_OIDC_TRUSTED_ROLES` / `FLOWGRAPH_OIDC_TRUSTED_TEAMS` | _(empty)_ | Callers with one of these roles or teams are **trusted authors** (below). Empty means nobody is |
| `FLOWGRAPH_INSECURE_DEV` | off | Allow `http` issuer URLs and auth-less durable servers. Dev only |

In `oidc` mode each caller is a principal `org/subject`:

- **Runs.** A thread belongs to the principal that started it. Another principal gets 403 `THREAD_NOT_OWNED` on every read, control and event call for it (thread ids are global, so a 403 tells the caller the id is in use); `GET /runs` lists only your own threads. Live events for an unknown thread are a 404, so start a run before subscribing to it.
- **Memory.** Runs write memory as `{ org, project, user: subject }` of the caller, and only the same principal can resume a thread bound to memory (`MEMORY_SCOPE_MISMATCH`).
- **Graph names.** The first principal to upload a graph `metadata.name` in an org owns it; anyone else gets 409 `GRAPH_NAME_TAKEN`. Names are kept in the memory database (`fg_graph_names`) with `FLOWGRAPH_MEMORY_BACKEND=sqlite` or `postgres`; on the default backend they are per process and the server logs a warning.

In `token` and `none` mode there is one principal, so none of these checks apply. Reusing a thread id for a different graph is a 409 `THREAD_ID_CONFLICT` in every mode.

### Uploaded graphs from untrusted authors

A graph uploaded by a caller who is not a trusted author is checked when it is uploaded and again when it runs, and refused with a 403 naming the first problem (`diagnostics` lists all of them):

| `code` | Refused |
|---|---|
| `UPLOAD_NODE_TYPE_BLOCKED` | `shell`, `script`, `service`, `worktree`, `skill` and `demo` nodes, including inside `map` and subgraphs |
| `UPLOAD_SUBGRAPH_FILE_BLOCKED` | subgraphs loaded from a file on the server (`uses:`); inline `spec:` subgraphs are checked like the parent |
| `UPLOAD_ENV_PLACEHOLDER_BLOCKED` / `UPLOAD_SECRET_REFERENCE_BLOCKED` | `${VAR}` placeholders and `{{ secrets.* }}` templates, which would read the server's environment |
| `UPLOAD_HOST_PATH_BLOCKED` | node `workspace`, `runtime.workspace`, `runtime.worktrees.root` and workshop `with.diff` paths |
| `UPLOAD_AGENT_SKILL_TOOL_BLOCKED` | agents given the `skill` tool |
| `UPLOAD_PROVIDER_OVERRIDE_BLOCKED` | provider `baseUrl`, `apiKeyEnv`, `cwd`, and `options` other than sampling settings (`temperature`, `maxTokens`, `topP`, `stop`, `seed`, `timeout`, `reasoningEffort`, …) |

At run time the same node types, file subgraphs and secret lookups are also refused by the engine (`NODE_TYPE_BLOCKED`, `SUBGRAPH_FILE_BLOCKED`, `SECRET_REFERENCE_BLOCKED`). Trusted authors are `oidc` callers with a trusted role or team, every `token` caller, and `none` mode only with `FLOWGRAPH_INSECURE_DEV=1`.

### Auth errors

Errors are JSON `{ "error", "code" }`; 401s also send `WWW-Authenticate: Bearer`.

| Status | `code` | When |
|---|---|---|
| 401 | `AUTH_REQUIRED` | No `Authorization` header |
| 401 | `AUTH_INVALID_TOKEN` | Bad signature, algorithm, `aud`, `iss`, `nbf`, `iat`, unknown `kid`, or no `sub` |
| 401 | `AUTH_TOKEN_EXPIRED` | `exp` passed (beyond the skew) |
| 403 | `AUTH_NO_ORG` | No org claim and no `FLOWGRAPH_ORG` |
| 503 | `AUTH_PROVIDER_UNAVAILABLE` | Discovery or JWKS could not be read, or discovery named a different issuer |
| 403 | `THREAD_NOT_OWNED` | Another principal's thread |
| 404 | `THREAD_NOT_FOUND` | Unknown thread |
| 409 | `THREAD_ID_CONFLICT` / `GRAPH_NAME_TAKEN` | Thread id used for a different graph / graph name owned by someone else |

## Voice tokens (`POST /voice/client-secrets`)

Mints a short-lived realtime voice token for a workshop client using the server's `XAI_API_KEY` (or `GROK_API_KEY`) / `OPENAI_API_KEY`. Body: `{ "provider"?: "xai" | "openai", "model"?: string }`.

| Env | Default | Purpose |
|---|---|---|
| `FLOWGRAPH_VOICE_ALLOW_UNAUTHENTICATED` | off | Mint even when REST auth is off (`FLOWGRAPH_AUTH_DISABLED=1` or no token). **Anyone who can reach the port can then spend your vendor key.** Logs a loud warning at startup and on every mint. Local/dev only. |
| `FLOWGRAPH_VOICE_ALLOWED_MODELS` | `grok-voice-latest,gpt-4o-realtime-preview` | Comma-separated models callers may request (config: `voice.allowedModels`). |

Errors are generic to callers; upstream vendor detail is only logged server-side (`voice.mint-failed`).

| Status | `code` | When |
|---|---|---|
| 403 | `VOICE_AUTH_REQUIRED` | REST auth is off and the opt-in is not set |
| 400 | `VOICE_MODEL_NOT_ALLOWED` / `VOICE_PROVIDER_NOT_ALLOWED` | Model not in the allowlist / unknown provider |
| 503 | `VOICE_NOT_CONFIGURED` | No vendor key on the server |
| 502 | `VOICE_MINT_FAILED` | Vendor rejected or failed the mint |

## Limits

| Env | Default | Purpose |
|---|---|---|
| `FLOWGRAPH_MAX_BODY_BYTES` | `2000000` | JSON body cap for `POST /runs` and control endpoints (`0` = unlimited) |
| `FLOWGRAPH_MAX_CONCURRENT_RUNS` | `16` | In-flight `running`/`started` threads per process (`0` = unlimited) |
| `FLOWGRAPH_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. `GET /ping` access logs are `debug`. |
| `FLOWGRAPH_GIT_SHA` | _(unset)_ | Optional build identity included on `/` and `/healthz`. |
| `FLOWGRAPH_GRAPH_STORE` | `/tmp/flowgraph-graphs` | Uploaded YAML + `{threadId}.events.jsonl`. **Do not use `/tmp` on a lab host** — it is wiped on reboot. |

## Memory

Graphs that declare `runtime.memory` need a durable memory backend; on the default backend they fail with an error that names `FLOWGRAPH_MEMORY_BACKEND`. The server is optional: the `flowgraph` CLI keeps memory locally and never needs it or these variables. See [docs/05-state-and-data.md §8](../../docs/05-state-and-data.md#8-long-term-memory-runtimememory).

| Env | Default | Purpose |
|---|---|---|
| `FLOWGRAPH_MEMORY_BACKEND` | `memory` | `memory` (process-local; `runtime.memory` graphs fail to compile) \| `postgres` (the `DATABASE_URL` database, same pool as checkpoints; behind PgBouncer use session mode, not transaction mode) \| `sqlite` (local file; install `@flowgraph/checkpoint-sqlite`) |
| `FLOWGRAPH_MEMORY_SQLITE_PATH` | `<FLOWGRAPH_GRAPH_STORE>/memory.db` | sqlite memory file. Per replica: with several replicas use `postgres`, or memory splits between them |
| `FLOWGRAPH_ORG` | _(required for `postgres` / `sqlite` outside `oidc` mode)_ | The org every run on this server writes memory as. With a durable backend, no `FLOWGRAPH_ORG` and no OIDC the server refuses to start. In `oidc` mode memory is written as the caller instead, and this is only the fallback org for tokens without an org claim |
| `FLOWGRAPH_PROJECT` / `FLOWGRAPH_USER` | `local` / _(unset)_ | Project and user of that one identity (`FLOWGRAPH_USER` is ignored in `oidc` mode) |
| `FLOWGRAPH_SETUP_LOCK_TIMEOUT_MS` | `60000` | How long Postgres schema setup waits for another replica's setup lock before failing with `FLOWGRAPH_SETUP_LOCK_TIMEOUT` |
| `FLOWGRAPH_MEMORY_SWEEP_MS` | `3600000` | How often expired memory and old replay records are deleted (whole milliseconds, 1000 to 2147483647; anything else stops startup). On Postgres one replica sweeps per interval |

## Lab / self-host

Point stdout at a file (launchd `StandardOutPath` / `StandardErrorPath`, or a redirect):

`~/Library/Logs/flowgraph-server.log`

When a run fails, paste:

1. `GET /healthz` JSON (identity + credentials presence, not secret values)
2. Log tail covering start → failure
3. `threadId` plus the graph-store files `{threadId}.graph.yaml` and `{threadId}.events.jsonl`

Do not dump `process.env` or bearer tokens.

Event dump without SSE:

```bash
curl -s -H "Authorization: Bearer dev" http://127.0.0.1:8080/runs/t1/journal
```

## Listing and reattach

```bash
curl -s -H "Authorization: Bearer dev" http://127.0.0.1:8080/runs
curl -s -H "Authorization: Bearer dev" http://127.0.0.1:8080/runs/t1
```

`POST /runs` accepts `dryRun: true` to compile with the mock provider only.

## Control-plane connect (ADR-0014)

Optional outbound WebSocket client. Off unless configured:

```bash
FLOWGRAPH_CONNECT_URL=wss://platform.example/connect \
FLOWGRAPH_CONNECT_TOKEN=… \
node packages/server/dist/bin.js
```

Handshake: client sends `{ type: "hello", protocolVersion: 1, token, capabilities }`; platform replies `{ type: "hello.ack", protocolVersion: 1, sessionId }`. Commands (`run.start|resume|cancel|pause|continue|state|history|list`) map onto `RunService`; engine events are batched as `{ type: "event.batch", threadId, events }`.

## TLS

Pass `certificate_arn` to Terraform to terminate HTTPS on the ALB (HTTP redirects to 443). HTTP-only ALB is for smoke tests — do not expose it on the public internet.

## v1 graph-source constraints

- Clients upload graph YAML in the start request; it is persisted under `FLOWGRAPH_GRAPH_STORE`.
- Client `imports` (custom nodes/providers/reducers modules) are **stripped** and not executed.
- Only built-in node types + YAML `providers:` with `kind: langchain` (including `vendor: bedrock`) are supported.
- Client-supplied provider secrets in `env` are **rejected**. Use the task IAM role for Bedrock and Secrets Manager / task env for API keys.

## Deploy

See [`deploy/terraform`](./deploy/terraform) for ECS/Fargate + RDS + ALB, and [`deploy/agentcore`](./deploy/agentcore) for registering the same image as an AgentCore Runtime.

## Docker

```bash
docker build --platform linux/arm64 -t flowgraph-server -f packages/server/Dockerfile .
docker run --rm -p 8080:8080 -e FLOWGRAPH_AUTH_TOKEN=dev flowgraph-server
curl -s http://127.0.0.1:8080/ping
```
