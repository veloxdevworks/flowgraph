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

REST requires `FLOWGRAPH_AUTH_TOKEN` unless you explicitly opt out with `FLOWGRAPH_AUTH_DISABLED=1` (local/dev only). AgentCore `/ping` and `/invocations` skip bearer auth (SigV4 at the edge).

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

Graphs that declare `runtime.memory` need a durable memory backend. See [docs/05-state-and-data.md §8](../../docs/05-state-and-data.md#8-long-term-memory-runtimememory).

| Env | Default | Purpose |
|---|---|---|
| `FLOWGRAPH_MEMORY_BACKEND` | `memory` | `memory` (process-local; `runtime.memory` graphs fail to compile) \| `postgres` (the `DATABASE_URL` database, same pool as checkpoints) \| `sqlite` (local file; install `@flowgraph/checkpoint-sqlite`) |
| `FLOWGRAPH_MEMORY_SQLITE_PATH` | `<FLOWGRAPH_GRAPH_STORE>/memory.db` | sqlite memory file |
| `FLOWGRAPH_ORG` / `FLOWGRAPH_PROJECT` / `FLOWGRAPH_USER` | `local` / `local` / _(unset)_ | The one identity every run on this server writes memory as |
| `FLOWGRAPH_MEMORY_SWEEP_MS` | `3600000` | How often expired memory and old replay records are deleted |

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
