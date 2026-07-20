# Register flowgraph-server as a Bedrock AgentCore Runtime

The same ARM64 image used for ECS/Fargate implements the AgentCore HTTP contract:

- `GET /ping` → `{ status: "Healthy" | "HealthyBusy" }`
- `POST /invocations` with `{ action, threadId, yaml, ... }`

Share the Postgres `DATABASE_URL` with the ECS deployment so resume/state works across both.

## Prerequisites

- Image pushed to ECR (linux/arm64)
- AWS CLI v2 with permissions for `bedrock-agentcore` / AgentCore Runtime
- Optional: same VPC/RDS as the Terraform stack

## Push image

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-us-east-1}
REPO=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/flowgraph-server

aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build --platform linux/arm64 -t flowgraph-server -f packages/server/Dockerfile .
docker tag flowgraph-server:latest $REPO:latest
docker push $REPO:latest
```

## Create runtime

```bash
./register.sh \
  --region "$REGION" \
  --image-uri "$REPO:latest" \
  --database-url "$DATABASE_URL" \
  --role-arn "$AGENTCORE_EXECUTION_ROLE_ARN"
```

## Invoke from desktop / CLI

```bash
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$RUNTIME_ARN" \
  --payload "$(jq -c -n --arg y "$(cat graph.yaml)" '{action:"start",threadId:"t1",yaml:$y,input:{text:"hi"},stream:true}')" \
  outfile.bin
```

Desktop remote mode can target the ECS ALB REST+SSE path; AgentCore SigV4 invoke is an alternate ingress for the same container.
