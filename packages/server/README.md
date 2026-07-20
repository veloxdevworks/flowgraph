# `@veloxdevworks/flowgraph-server`

HTTP run server for hosted flowgraph execution. One ARM64 container serves:

- **Generic REST + SSE** — for ECS/Fargate behind an ALB (desktop remote transport)
- **Bedrock AgentCore Runtime** — `GET /ping` + `POST /invocations`

## Quick start (local)

```bash
pnpm --filter @veloxdevworks/flowgraph-server build
DATABASE_URL=          # optional; omit for in-memory checkpoints
FLOWGRAPH_AUTH_TOKEN=dev \
FLOWGRAPH_GRAPH_STORE=/tmp/fg-graphs \
node packages/server/dist/bin.js
```

```bash
# Health
curl -s http://127.0.0.1:8080/healthz

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
