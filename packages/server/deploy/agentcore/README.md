# Run flowgraph-server on Bedrock AgentCore Runtime

The same ARM64 image used for ECS/Fargate implements the AgentCore HTTP contract
(`GET /ping`, `POST /invocations` on port 8080). AgentCore runs it serverlessly:
you pay while a session's microVM is up, and callers authenticate with IAM (SigV4).

| File | What it does |
|------|--------------|
| `create-role.sh` | Creates the IAM execution role the runtime assumes (ECR pull, logs, X-Ray, Bedrock). |
| `register.sh` | Creates or updates the runtime, waits for `READY`, prints its ARN. |
| `invoke.sh` | Calls the runtime for one thread (`start`, `resume`, `events`, `state`, …). |
| `hello-approval.graph.yaml` | Deployment check that needs no model access. |
| `hello-bedrock.graph.yaml` | One Bedrock call through the execution role. |

## How AgentCore runs flowgraph

- **One microVM per session.** Every distinct `runtimeSessionId` gets its own microVM.
  A run lives in the memory of the microVM that started it, so every call about a
  thread must use the same session id. `invoke.sh` derives it from the thread id
  (`flowgraph-` + sha256), so you never pass it yourself.
- **Sessions stop.** A microVM is stopped after `--idle-timeout` with no request and no
  run in progress (default 15 min), and after `--max-lifetime` regardless (default 8 h).
  The next call for that thread gets a fresh microVM.
- **What survives a stop.** Without `DATABASE_URL`, checkpoints are in memory, so a run
  that was waiting for a human answer cannot be resumed after its microVM stops. Pick an
  idle timeout longer than you expect to wait. With `--session-storage`, the thread's
  graph YAML and event journal survive a stop (but are wiped when you update the runtime).
- **Who can call it.** Anyone with `bedrock-agentcore:InvokeAgentRuntime` on the runtime.
  They act as the server's single trusted principal: their graphs can read the
  container's environment through `${VAR}`. Grant invoke access accordingly.

## First run

Prerequisites: AWS CLI v2 (recent enough to have `aws bedrock-agentcore-control`), `jq`,
Docker with `buildx`, and credentials that can manage ECR, IAM and AgentCore in the account.

From the repository root:

```bash
export AWS_REGION=us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO=$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/flowgraph-server
TAG=$(git rev-parse --short HEAD)
```

**1. Push the image** (linux/arm64; on an x86 machine, first install arm64 emulation once with
`docker run --privileged --rm tonistiigi/binfmt --install arm64`):

```bash
aws ecr create-repository --repository-name flowgraph-server >/dev/null 2>&1 || true
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
docker buildx build --platform linux/arm64 -f packages/server/Dockerfile -t "$REPO:$TAG" --push .
```

Use a new tag for every deploy rather than reusing `latest`, so each runtime version
points at a distinct image.

**2. Create the execution role** (once):

```bash
ROLE_ARN=$(packages/server/deploy/agentcore/create-role.sh)
```

**3. Create the runtime:**

```bash
packages/server/deploy/agentcore/register.sh --image-uri "$REPO:$TAG" --role-arn "$ROLE_ARN" --idle-timeout 3600
```

It prints the runtime ARN. `export RUNTIME_ARN=...` with it.

**4. Check the deployment without a model** (stops at an approval gate, then finishes):

```bash
cd packages/server/deploy/agentcore
./invoke.sh --runtime-arn "$RUNTIME_ARN" --thread-id voyage-1 start --yaml hello-approval.graph.yaml
./invoke.sh --runtime-arn "$RUNTIME_ARN" --thread-id voyage-1 resume --resume '{"approved":true}'
```

The first call streams events ending in `interrupt.raised`; the second ends in `run.end`.

**5. Call Bedrock.** Enable model access for the model in the Bedrock console, set `model`
and `region` in `hello-bedrock.graph.yaml`, then:

```bash
./invoke.sh --runtime-arn "$RUNTIME_ARN" --thread-id voyage-2 start --yaml hello-bedrock.graph.yaml
```

The `node.output` / `run.end` events carry the reply. An `AccessDeniedException` means the
model is not enabled or the role's Bedrock statement does not cover it.

## Day two

- **Deploy a new image:** build and push a new tag, then run `register.sh` again with it. It
  finds the runtime by name and updates it in place (same ARN, new version). An update wipes
  session storage; deploy when no run is waiting on a human.
- **Follow or replay a thread:** `./invoke.sh ... --thread-id T events --after-seq 0`.
  On a microVM that never ran the thread, the stream ends at once (with the journal replay
  if `--session-storage` kept it).
- **Cancel / pause / inspect:** `cancel`, `pause`, `state`, `history` with the same thread id.
- **Logs:** CloudWatch log groups under `/aws/bedrock-agentcore/runtimes/<runtime-id>-*`.
  The server logs JSON lines (`run.start`, `run.end`, `http.access`, errors with stacks).
- **Payload shape:** `invoke.sh` sends `{ action, threadId, yaml?, input?, resume?, afterSeq?, stream? }`
  as JSON; see `src/http/agentcore.ts`. Calling `invoke-agent-runtime` yourself needs
  `--runtime-session-id` (33+ characters) and `--cli-binary-format raw-in-base64-out`.

## Options worth knowing

| `register.sh` flag | Use |
|--------------------|-----|
| `--idle-timeout S` | How long a session may sit idle (waiting on a human counts as idle). |
| `--session-storage /mnt/flowgraph` | Keep each thread's YAML and event journal across microVM stops (AgentCore Preview feature). |
| `--subnets … --security-groups …` | VPC mode, to reach private resources such as a database. |
| `--env KEY=VALUE` | Extra environment. Stored in plain text on the runtime: no secrets. |
| `--dry-run` | Print the request without calling AWS. |

## Not covered yet

- **Shared Postgres.** Durable checkpoints across microVMs need `DATABASE_URL` and VPC mode
  with a security group the database allows. Passing the URL with `--env` puts the password
  in plain text on the runtime; fetch it from Secrets Manager at startup instead before
  relying on it.
- **OIDC callers.** For per-user identity, the runtime needs a custom JWT authorizer and
  `Authorization` in its request-header allowlist, and the server `FLOWGRAPH_OIDC_*`
  settings. `register.sh` does not set these up.
- **The desktop app** can target the ECS REST path today, not AgentCore.
