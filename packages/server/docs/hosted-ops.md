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

- Structured JSON logs on stdout (`level`, `msg`, `threadId`, `runId`, …).
- `GET /healthz` returns `{ ok, metrics: { runsStarted, runsCompleted, runsInterrupted, runsFailed, runsCancelled }, activeRuns, database, credentials }` where `credentials` is the same introspection object as on `GET /` (`vendorKeys`, `awsRegion`, `hasAwsKeys`, `hasBedrockIamHint`).
- ECS: CloudWatch log group `/ecs/flowgraph-server` (see Terraform).
- Desktop Runner surfaces `run.error` and HTTP error messages in the EVENT LOG.

## Known gaps (Bedrock)

- LangChain `ChatBedrockConverse` does not populate `costUSD` in usage events — cost accounting remains a follow-up.
- Agent tool-calling against Converse tool schema should be validated in your account before production (same note as local Bedrock runs).

## HITL

1. Server emits `interrupt.raised` over SSE.
2. Desktop `HitlPrompt` collects a value.
3. Client `POST /runs/:threadId/resume` (fire-and-forget; returns `202`/`started`) with `{ resume }`.
4. Further interrupts arrive over SSE (`interrupt.raised`); `GET /runs/:threadId/state` recovers pending interrupts after reconnect.
