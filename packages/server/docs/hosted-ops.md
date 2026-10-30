# Hosted run operations

## Auth

| Ingress | Auth |
|---------|------|
| REST (`/runs`, `/healthz`, …) | `Authorization: Bearer <FLOWGRAPH_AUTH_TOKEN>` when the env var is set. Desktop stores the token in the OS keychain (`flowgraph` / `serverAuthToken`). |
| AgentCore (`/ping`, `/invocations`) | AWS SigV4 / OAuth at the AgentCore edge. No bearer check inside the container. |

## Credentials

Remote clients **must not** send provider secrets. The server rejects any `env` object on start.

| Backend | Source |
|---------|--------|
| Bedrock | Task / AgentCore execution IAM role (`bedrock:InvokeModel`, `Converse`, …) + `AWS_REGION` |
| OpenAI / Anthropic / Google / xAI | Task env or Secrets Manager injection (`OPENAI_API_KEY`, …) |

## Observability

- Structured JSON logs on stdout (`level`, `msg`, `threadId`, `runId`, `stack` on errors). Honor `FLOWGRAPH_LOG_LEVEL` (`debug`/`info`/`warn`/`error`, default `info`).
- `http.access` on every request (method, path, status, durationMs, remote). `GET /ping` is logged at **debug** so Docker healthchecks stay quiet.
- `events.subscribe` / `events.close` for SSE attach/detach (`threadId`, `lastEventId` / `lastSeq`). Heartbeats are not logged.
- Uncaught exceptions and unhandled rejections are logged with stack then the process exits.
- `GET /healthz` and `GET /` include `identity` (`version`, `node`, `platform`, `arch`, `hostname`, `pid`, `uptimeSec`, `graphStoreDir`, `database`, `gitSha`) plus existing `metrics`, `activeRuns`, and `credentials` (`vendorKeys`, `awsRegion`, `hasAwsKeys`, `hasBedrockIamHint` — keys present, not values).
- Per-thread event journal: `{FLOWGRAPH_GRAPH_STORE}/{threadId}.events.jsonl`. `GET /runs/:threadId/journal` returns the same events after a process restart.
- ECS: CloudWatch log group `/ecs/flowgraph-server` (see Terraform). On a Mac mini, redirect stdout to `~/Library/Logs/flowgraph-server.log`.
- Desktop Runner surfaces `run.error` and HTTP error messages in the EVENT LOG. Settings → Test connection shows identity from `/healthz`.

### Bug report (lab)

Paste `/healthz`, the log tail, `threadId`, and the graph-store YAML + `events.jsonl`. Do not include env dumps or auth tokens.

## Known gaps (Bedrock)

- LangChain `ChatBedrockConverse` does not populate `costUSD` in usage events — cost accounting remains a follow-up.
- Agent tool-calling against Converse tool schema should be validated in your account before production (same note as local Bedrock runs).

## HITL

1. Server emits `interrupt.raised` over SSE.
2. Desktop `HitlPrompt` collects a value.
3. Client `POST /runs/:threadId/resume` (fire-and-forget; returns `202`/`started`) with `{ resume }`.
4. Further interrupts arrive over SSE (`interrupt.raised`); `GET /runs/:threadId/state` recovers pending interrupts after reconnect.
