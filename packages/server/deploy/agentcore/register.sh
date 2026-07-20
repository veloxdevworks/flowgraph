#!/usr/bin/env bash
# Register (or update) a Bedrock AgentCore Runtime pointing at the flowgraph-server image.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
NAME="flowgraph-server"
IMAGE_URI=""
DATABASE_URL=""
ROLE_ARN=""
GRAPH_STORE="/data/graphs"

usage() {
  cat <<EOF
Usage: $0 --image-uri URI --database-url URL --role-arn ARN [--region R] [--name N]
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --image-uri) IMAGE_URI="$2"; shift 2 ;;
    --database-url) DATABASE_URL="$2"; shift 2 ;;
    --role-arn) ROLE_ARN="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$IMAGE_URI" && -n "$DATABASE_URL" && -n "$ROLE_ARN" ]] || usage

echo "Creating/updating AgentCore runtime name=$NAME region=$REGION"

# Prefer the AgentCore control-plane API when available. Fall back to documenting
# console steps if the CLI verb is not present in this CLI build.
if aws bedrock-agentcore help >/dev/null 2>&1 || aws bedrock-agentcore-control help >/dev/null 2>&1; then
  CTRL=bedrock-agentcore-control
  if ! aws "$CTRL" help >/dev/null 2>&1; then
    CTRL=bedrock-agentcore
  fi

  ENV_JSON=$(jq -n \
    --arg db "$DATABASE_URL" \
    --arg region "$REGION" \
    --arg store "$GRAPH_STORE" \
    '{
      DATABASE_URL: $db,
      AWS_REGION: $region,
      AWS_DEFAULT_REGION: $region,
      FLOWGRAPH_HOST: "0.0.0.0",
      FLOWGRAPH_PORT: "8080",
      FLOWGRAPH_GRAPH_STORE: $store
    }')

  if aws "$CTRL" create-agent-runtime \
      --region "$REGION" \
      --agent-runtime-name "$NAME" \
      --role-arn "$ROLE_ARN" \
      --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$IMAGE_URI\"}}" \
      --network-configuration '{"networkMode":"PUBLIC"}' \
      --protocol-configuration '{"serverProtocol":"HTTP"}' \
      --environment-variables "$ENV_JSON" \
      2>/tmp/agentcore-create.err; then
    echo "Runtime created."
  else
    echo "create-agent-runtime failed (may already exist); attempting update..."
    cat /tmp/agentcore-create.err || true
    aws "$CTRL" update-agent-runtime \
      --region "$REGION" \
      --agent-runtime-id "$NAME" \
      --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$IMAGE_URI\"}}" \
      --environment-variables "$ENV_JSON" || {
        echo "Update failed. Register via the Bedrock AgentCore console with image $IMAGE_URI"
        exit 1
      }
  fi
else
  cat <<EOF
AWS CLI AgentCore commands are not available in this environment.

Register manually in the Bedrock AgentCore console:
  1. Create Runtime (custom container, HTTP protocol)
  2. Image URI: $IMAGE_URI  (must be linux/arm64)
  3. Port 8080, endpoints /ping and /invocations
  4. Environment:
       DATABASE_URL=$DATABASE_URL
       AWS_REGION=$REGION
       AWS_DEFAULT_REGION=$REGION
       FLOWGRAPH_HOST=0.0.0.0
       FLOWGRAPH_PORT=8080
       FLOWGRAPH_GRAPH_STORE=$GRAPH_STORE
  5. Execution role: $ROLE_ARN
     (needs bedrock:InvokeModel + RDS/Secrets access as appropriate)
EOF
  exit 0
fi
