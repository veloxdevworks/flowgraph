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

`FLOWGRAPH_OIDC_ISSUER` cannot be combined with `FLOWGRAPH_AUTH_TOKEN` or `FLOWGRAPH_AUTH_DISABLED`; `FLOWGRAPH_AUTH_MODE` (`oidc` \| `token` \| `none`) must match the variables that are set. AgentCore `/ping` is always open. `/invocations` skips bearer auth in `token` and `none` mode (AgentCore checks SigV4 at the edge), but in `oidc` mode it needs `Authorization: Bearer <jwt>` exactly like REST: no token, a malformed or forged one is a 401, and a valid one acts as that caller, so another caller's thread is a 403 `THREAD_NOT_OWNED`. Over the connect channel, `oidc` mode needs the user's JWT in each command's `params.accessToken` ([trust model](#control-plane-connect-adr-0014)).

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
  The owner is stored next to the checkpoints (`fg_thread_owners`): in Postgres when `DATABASE_URL` is set, so every replica sharing the database agrees, else in the sqlite memory file with `FLOWGRAPH_MEMORY_BACKEND=sqlite`, else in process memory alongside the in-memory checkpoints. Losing a replica's graph store does not hand a thread to someone else. On startup a multi-user server copies the owners recorded in its graph store's meta files into this store (once per thread; existing owners are never changed), so threads started before an upgrade stay with their owners on every replica; start each replica that has its own graph store once after upgrading. A thread id with saved checkpoints but no recorded owner anywhere is refused for everyone; use a new id. When the owner cannot be looked up (the database is down) the call is a 503 `THREAD_OWNER_UNAVAILABLE`, never a guess.
- **Memory.** Runs write memory as `{ org, project, user: subject }` of the caller, and only the same principal can resume a thread bound to memory (`MEMORY_SCOPE_MISMATCH`).
- **Graph names.** The first principal to upload a graph `metadata.name` in an org owns it; anyone else gets 409 `GRAPH_NAME_TAKEN`. Names are kept in Postgres (`fg_graph_names`) when `DATABASE_URL` is set, or in the sqlite memory file with `FLOWGRAPH_MEMORY_BACKEND=sqlite`; otherwise they are per process and the server logs a warning. Run replicas with `DATABASE_URL`. Names are lower-case kebab-case, so case or Unicode look-alikes of a taken name are refused when the graph is parsed.

In `token` and `none` mode there is one principal, so none of these checks apply. Reusing a thread id for a different graph is a 409 `THREAD_ID_CONFLICT` in every mode; on multi-user servers only to the thread's owner (anyone else gets 403 `THREAD_NOT_OWNED`, without the stored id).

### Uploaded graphs from untrusted authors

**Some untrusted uploads that ran on earlier versions are now refused**; see [Upgrading from 0.1](#upgrading-from-01) for what to change.

A graph uploaded by a caller who is not a trusted author is checked when it is uploaded and again when it runs, and refused with a 403 naming the first problem (`diagnostics` lists all of them):

| `code` | Refused |
|---|---|
| `UPLOAD_NODE_TYPE_BLOCKED` | `shell`, `script`, `service`, `worktree`, `skill`, `demo` and `mcp` nodes, including inside `map` and subgraphs |
| `UPLOAD_SUBGRAPH_FILE_BLOCKED` | subgraphs loaded from a file on the server (`uses:`); inline `spec:` subgraphs are checked like the parent |
| `UPLOAD_ENV_PLACEHOLDER_BLOCKED` / `UPLOAD_SECRET_REFERENCE_BLOCKED` | `${VAR}` placeholders and `{{ secrets.* }}` templates, which would read the server's environment |
| `UPLOAD_HOST_PATH_BLOCKED` | node `workspace`, `runtime.workspace`, `runtime.worktrees.root`, and workshop or `hitl` `mode: review` `with.diff` that runs `git diff` on the server (a `before` / `after` diff is allowed; a review with no `diff` shows none) |
| `UPLOAD_RUNTIME_HOST_EXEC_BLOCKED` | `runtime.services.rehydrateOnResume` (restarts saved service commands on resume) and `runtime.worktrees.cleanupOnEnd` (runs `git worktree remove`) |
| `UPLOAD_RESERVED_CHANNEL_BLOCKED` | declaring, writing (`output.to`), giving a default `input` for, or naming in a subgraph `stateMap.in` / `stateMap.out` (keys or values) any state channel whose name starts with `__`; that prefix is the engine's own (`__services`, `__worktrees`, `__agentReplay`, `__once`, `__mapCollect`, `__mapTask`, `__issues`, `__interrupt__`, and any it adds later) |
| `UPLOAD_AGENT_REF_BLOCKED` | agents with `with.agent`, which loads an agent definition from the server's disk or an installed package |
| `UPLOAD_IMPORTS_BLOCKED` | graph `imports`, at the top level or in inline subgraphs and `map` inners (they load modules on the server; uploads strip them for every caller, see below) |
| `UPLOAD_INBOUND_WEBHOOK_BLOCKED` | `wait` nodes with `with.webhook` and `runtime.webhookServer`, which listen on a port on the server |
| `UPLOAD_AGENT_SKILL_TOOL_BLOCKED` | agents given the `skill` tool |
| `UPLOAD_AGENT_TOOL_BLOCKED` | agent tools that run on the host: `start_service`, `stop_service`, `restart_service`, the file tools (`Read`, `Write`, `Edit`, `Glob`, `Bash`, `fs_*`) and any other registered function tool. `ask_human`, `list_services` and `service_status` stay allowed, plus `FLOWGRAPH_UNTRUSTED_ALLOW_TOOLS` |
| `UPLOAD_FUNCTION_BLOCKED` | `function` / `code` nodes, which call functions registered in the server process, unless listed in `FLOWGRAPH_UNTRUSTED_ALLOW_FUNCTIONS` |
| `UPLOAD_PROVIDER_OVERRIDE_BLOCKED` | provider `apiKeyEnv`, `cwd`, and `options` other than sampling settings (`temperature`, `maxTokens`, `topP`, `stop`, `seed`, `timeout`, `reasoningEffort`, …) |
| `UPLOAD_PROVIDER_ENDPOINT_BLOCKED` | custom provider endpoints (`baseUrl`), and the `ollama` vendor or `config.defaults.provider: ollama`, whose default endpoint is a model server on the host (`localhost:11434`) |
| `UPLOAD_HTTP_TARGET_BLOCKED` | literal `http` / `webhook` URLs that are not `http(s)`, or whose host is `localhost` or a non-public IP (loopback, private, link-local, CGNAT, cloud metadata, and their IPv6 and IPv4-mapped forms) |
| `UPLOAD_MCP_BLOCKED` | `mcpServers` (stdio servers start host processes; http servers reach any address) and agents given `{ mcp: … }` tools |
| `UPLOAD_LOCAL_TOOLS_BLOCKED` | `localTools`, which run file tools on the server |
| `UPLOAD_HOST_PROBE_BLOCKED` | `with.requires`, which checks which programs are installed on the server |

At run time the engine enforces the same limits again (`NODE_TYPE_BLOCKED`, `SUBGRAPH_FILE_BLOCKED`, `SECRET_REFERENCE_BLOCKED`, `MCP_BLOCKED`, `LOCAL_TOOLS_BLOCKED`, `HOST_PROBE_BLOCKED`, `TOOL_BLOCKED`, `FUNCTION_BLOCKED`, `HOST_EXEC_BLOCKED`, `RESERVED_CHANNEL_BLOCKED`, `AGENT_REF_BLOCKED`, `IMPORTS_BLOCKED`, `INBOUND_WEBHOOK_BLOCKED`; an untrusted graph sees only the providers it declares, never ones registered by the server or by other graphs; saved service and worktree entries are not restarted or removed for such a graph; the service tools refuse to start, stop or restart anything for a graph whose policy blocks `service` nodes; the MCP hub is never handed to an untrusted graph), and building providers refuses `ollama` and `baseUrl` with 403 `PROVIDER_ENDPOINT_BLOCKED`. Trusted authors are `oidc` callers with a trusted role or team, every `token` caller, and `none` mode only with `FLOWGRAPH_INSECURE_DEV=1`.

**Outbound requests.** `http` and `webhook` nodes in untrusted graphs may reach only public addresses. Templated URLs are checked when the request is made: the host is resolved and every address it resolves to is checked before connecting (so DNS rebinding to an inner address is refused), and redirects are followed by hand with the same check on every hop; a redirect to a blocked address is never followed. Refusals name the address and the reason (`OUTBOUND_ADDRESS_BLOCKED`; `OUTBOUND_URL_BLOCKED` for non-http schemes). Each request, redirects and body included, has 30 s (`OUTBOUND_TIMEOUT`) and reads at most 10 MiB of response (`OUTBOUND_RESPONSE_TOO_LARGE`). To let untrusted graphs call specific inner services, list them:

| Env | Default | Purpose |
|---|---|---|
| `FLOWGRAPH_UNTRUSTED_ALLOW_TOOLS` | _(unset)_ | Comma-separated agent tool names untrusted graphs may use beyond `ask_human`, `list_services` and `service_status`. Listing a service tool does not let it start anything; `service` stays a blocked node type |
| `FLOWGRAPH_UNTRUSTED_ALLOW_FUNCTIONS` | _(unset: none)_ | Comma-separated registered function names untrusted `function` and `code` nodes may call (agent function tools are listed in `FLOWGRAPH_UNTRUSTED_ALLOW_TOOLS`). Only list functions that are safe for any caller |
| `FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS` | _(unset: public addresses only)_ | Comma-separated `host`, `host:port`, `*.domain` or `[v6]:port` entries that untrusted `http` / `webhook` nodes may reach even though they resolve to private, loopback or CGNAT addresses. Public hosts stay reachable either way. Cloud metadata (`169.254.169.254`, `fd00:ec2::254`, …) and link-local addresses are never allowed |

**Stored graphs.** The graph store (`{threadId}.graph.yaml`), the live session and `GET /runs/:id` keep the YAML as it was uploaded. `${VAR}` placeholders in a trusted author's graph are filled from the server environment each time it runs and are never written back; an untrusted author cannot upload them, and a stored placeholder is refused if its author has since lost trust. Files stored by servers before 0.2 hold YAML that was expanded at upload; they are read as they are and never expanded again.

### Auth errors

Errors are JSON `{ "error", "code" }`; 401s also send `WWW-Authenticate: Bearer`.

| Status | `code` | When |
|---|---|---|
| 401 | `AUTH_REQUIRED` | No `Authorization` header |
| 401 | `AUTH_INVALID_TOKEN` | Bad signature, algorithm, `aud`, `iss`, `nbf`, `iat`, unknown `kid`, or no `sub` |
| 401 | `AUTH_TOKEN_EXPIRED` | `exp` passed (beyond the skew) |
| 403 | `AUTH_NO_ORG` | No org claim and no `FLOWGRAPH_ORG` |
| 503 | `AUTH_PROVIDER_UNAVAILABLE` | Discovery or JWKS could not be read, discovery named a different issuer, or its `jwks_uri` is neither https nor on the issuer's origin. A failed discovery is retried after 5 s |
| 503 | `THREAD_OWNER_UNAVAILABLE` | The thread's owner could not be looked up (database unavailable) |
| 403 | `THREAD_NOT_OWNED` | Another principal's thread |
| 404 | `THREAD_NOT_FOUND` | Unknown thread |
| 409 | `THREAD_ID_CONFLICT` / `GRAPH_NAME_TAKEN` | Thread id used for a different graph / graph name owned by someone else |
| 403 | `RESERVED_CHANNEL_BLOCKED` | Run `input` sets an engine state channel (`__services`, `__worktrees`, `__agentReplay`, …). Refused for every caller and in every mode |

### Upgrading from 0.1

These changes can stop an existing deployment or graph until you act:

1. **Durable servers need an explicit auth mode.** With `DATABASE_URL` or `FLOWGRAPH_MEMORY_BACKEND=postgres|sqlite`, a server configured only with `FLOWGRAPH_AUTH_TOKEN` now refuses to start. Add `FLOWGRAPH_AUTH_MODE=token` to keep the single shared token (every caller is one principal), or move to `oidc`. `FLOWGRAPH_AUTH_DISABLED=1` on a durable server refuses to start unless `FLOWGRAPH_INSECURE_DEV=1`.
2. **`FLOWGRAPH_AUTH_DISABLED=1` callers are untrusted authors** unless `FLOWGRAPH_INSECURE_DEV=1` is also set, on any server. Their graphs get every limit in [the untrusted-author section](#uploaded-graphs-from-untrusted-authors): no `shell`, `script`, `service`, `worktree`, `skill`, `demo` or `mcp` nodes, no `mcpServers`, `localTools` or `requires`, no `${VAR}` or `secrets.*`, no `ollama` or `baseUrl` providers, and `http` / `webhook` nodes reach public addresses only. Set `FLOWGRAPH_INSECURE_DEV=1` on a local dev server to keep running such graphs, or use `token` mode.
3. **Untrusted uploads that ran before are refused.** Graphs from untrusted authors that used any of these now get a 403; change the graph or have a trusted author run it:
   - agent host tools (`start_service`, `stop_service`, `restart_service`, file tools, other registered function tools; `UPLOAD_AGENT_TOOL_BLOCKED`): drop them, or list safe ones in `FLOWGRAPH_UNTRUSTED_ALLOW_TOOLS`;
   - `function` / `code` nodes (`UPLOAD_FUNCTION_BLOCKED`): list safe functions in `FLOWGRAPH_UNTRUSTED_ALLOW_FUNCTIONS`;
   - workshop or `hitl` review `diff` with `cwd` / `base` / `paths` (`UPLOAD_HOST_PATH_BLOCKED`): pass `diff: { before, after }` text instead, or leave `diff` out;
   - `runtime.services.rehydrateOnResume` or `runtime.worktrees.cleanupOnEnd` (`UPLOAD_RUNTIME_HOST_EXEC_BLOCKED`): remove them; untrusted graphs cannot start services or worktrees anyway;
   - state channels starting with `__` in `state.channels`, `output.to`, `input` or a subgraph `stateMap` (`UPLOAD_RESERVED_CHANNEL_BLOCKED`): rename the channel;
   - agents with `with.agent` (`UPLOAD_AGENT_REF_BLOCKED`): inline the agent's prompt and tools in the node;
   - `imports` anywhere in the graph (`UPLOAD_IMPORTS_BLOCKED`): remove them; they were never run on the server;
   - `wait` nodes with `with.webhook`, or `runtime.webhookServer` (`UPLOAD_INBOUND_WEBHOOK_BLOCKED`): resume the thread through the server's API instead.
4. **Run input may not set any key starting with `__`** (`__services`, `__worktrees`, `__agentReplay`, …), from any caller: 403 `RESERVED_CHANNEL_BLOCKED`. Remove those keys from `input`.
5. **Thread owners move into the checkpoint store.** Start every replica once after upgrading so it copies the owners in its graph store's meta files (see *Runs* above); until a replica has done so, its pre-upgrade threads are refused on other replicas.

Also: reusing a thread id for a different graph is a 409 `THREAD_ID_CONFLICT`, and stored graph YAML is now kept as uploaded (see *Stored graphs* above). The `flowgraph` CLI runs graphs locally and is unaffected by all of this.

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
| `FLOWGRAPH_SHUTDOWN_TIMEOUT_MS` | `10000` | On SIGTERM / SIGINT the server stops accepting connections and new runs (503 `SERVER_CLOSING`), waits this long for runs in flight, aborts what is still running and gives it 2 s to settle, then closes database pools and exits. `RunService.close()` does the same for embedders |
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

**Trust model.** The server dials out to one platform relay that the operator chose by setting `FLOWGRAPH_CONNECT_URL`, and authenticates itself to it with `FLOWGRAPH_CONNECT_TOKEN`. That relay is trusted as part of the deployment, like the load balancer in front of REST:

- **Events.** Every event of every thread on this server is forwarded upstream, whoever started the run. The relay must apply its own per-user access control before showing events to anyone. Do not point `FLOWGRAPH_CONNECT_URL` at a relay you would not give read access to all runs.
- **Commands in `oidc` mode.** The relay is not a principal itself. Each command must carry the end user's own JWT as `params.accessToken`; the server verifies it exactly like a REST bearer token and runs the command as that user, with the same thread ownership, memory scope and trusted-author checks. A command without a valid token is refused with the same `AUTH_*` code. The relay can therefore act only for users whose tokens it holds.
- **Commands in `token` and `none` mode.** There is one principal, and the relay acts as it with full access. Use `oidc` for any multi-user deployment that uses connect.
- Use `wss://`; the connect token and forwarded access tokens travel on that socket.

## TLS

Pass `certificate_arn` to Terraform to terminate HTTPS on the ALB (HTTP redirects to 443). HTTP-only ALB is for smoke tests — do not expose it on the public internet.

## v1 graph-source constraints

- Clients upload graph YAML in the start request; it is persisted under `FLOWGRAPH_GRAPH_STORE`.
- Client `imports` (custom nodes/providers/reducers modules) are **stripped** and not executed, including `imports` inside inline subgraphs and `map` inners at any depth.
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
