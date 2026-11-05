#!/usr/bin/env bash
# Create or update a Bedrock AgentCore Runtime that runs the flowgraph-server image.
#
# Finds the runtime by name, creates it or updates it in place, waits until it
# is READY and prints its ARN. Needs AWS CLI v2 with `bedrock-agentcore-control`
# and jq. See README.md in this directory.
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
NAME="flowgraph_server"
IMAGE_URI=""
ROLE_ARN=""
SESSION_STORAGE=""
IDLE_TIMEOUT=900
MAX_LIFETIME=28800
SUBNETS=""
SECURITY_GROUPS=""
EXTRA_ENV=()
DRY_RUN=0
WAIT_SECONDS=600

usage() {
  cat <<EOF
Usage: $0 --image-uri URI --role-arn ARN [options]

Required:
  --image-uri URI           linux/arm64 image in ECR (e.g. <acct>.dkr.ecr.<region>.amazonaws.com/flowgraph-server:<tag>)
  --role-arn ARN            execution role (create one with ./create-role.sh)

Options:
  --region R                AWS region (default: \$AWS_REGION or us-east-1)
  --name N                  runtime name: letters, digits, _; starts with a letter (default: flowgraph_server)
  --session-storage PATH    mount per-session storage (Preview) at PATH (/mnt/<dir>) and keep the
                            graph store there, so a thread's YAML and event journal survive the
                            session's microVM being stopped. Wiped on every runtime update.
  --idle-timeout SECONDS    stop an idle session's microVM after this long (default 900, 60..1209600).
                            A run waiting on a human answer is idle; checkpoints without DATABASE_URL
                            are in memory, so pick a timeout longer than you expect to wait.
  --max-lifetime SECONDS    hard cap on a microVM's life (default 28800 = 8h)
  --subnets a,b             VPC mode: private subnet ids (needs --security-groups). Needed to reach
                            a private database or other VPC resources. Default: PUBLIC network mode.
  --security-groups a,b     VPC mode: security group ids
  --env KEY=VALUE           extra container environment (repeatable). Values are stored in plain text
                            on the runtime and shown by get-agent-runtime: no secrets here.
  --wait SECONDS            how long to wait for READY (default 600; 0 = do not wait)
  --dry-run                 print the request instead of sending it
EOF
  exit "${1:-1}"
}

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --image-uri) IMAGE_URI="$2"; shift 2 ;;
    --role-arn) ROLE_ARN="$2"; shift 2 ;;
    --session-storage) SESSION_STORAGE="$2"; shift 2 ;;
    --idle-timeout) IDLE_TIMEOUT="$2"; shift 2 ;;
    --max-lifetime) MAX_LIFETIME="$2"; shift 2 ;;
    --subnets) SUBNETS="$2"; shift 2 ;;
    --security-groups) SECURITY_GROUPS="$2"; shift 2 ;;
    --env) EXTRA_ENV+=("$2"); shift 2 ;;
    --wait) WAIT_SECONDS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[[ -n "$IMAGE_URI" && -n "$ROLE_ARN" ]] || usage
command -v jq >/dev/null || die "jq is required"
[[ "$NAME" =~ ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ ]] \
  || die "--name \"$NAME\": AgentCore runtime names are letters, digits and _ only, starting with a letter (max 48)"
[[ "$ROLE_ARN" =~ ^arn:aws(-[^:]+)?:iam::[0-9]{12}:role/.+ ]] || die "--role-arn does not look like an IAM role ARN"
if ! [[ "$IDLE_TIMEOUT" =~ ^[0-9]+$ ]] || (( IDLE_TIMEOUT < 60 || IDLE_TIMEOUT > 1209600 )); then
  die "--idle-timeout must be 60..1209600 seconds"
fi
if ! [[ "$MAX_LIFETIME" =~ ^[0-9]+$ ]] || (( MAX_LIFETIME < 60 )); then
  die "--max-lifetime must be at least 60 seconds"
fi
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || die "--wait must be a number of seconds"
if [[ -n "$SESSION_STORAGE" ]]; then
  [[ "$SESSION_STORAGE" =~ ^/mnt/[a-zA-Z0-9._-]+/?$ ]] \
    || die "--session-storage must be one directory under /mnt (e.g. /mnt/flowgraph)"
  SESSION_STORAGE="${SESSION_STORAGE%/}"
fi
if [[ -n "$SUBNETS" || -n "$SECURITY_GROUPS" ]]; then
  [[ -n "$SUBNETS" && -n "$SECURITY_GROUPS" ]] || die "VPC mode needs both --subnets and --security-groups"
fi

GRAPH_STORE="/data/graphs"
[[ -n "$SESSION_STORAGE" ]] && GRAPH_STORE="$SESSION_STORAGE/graphs"

# FLOWGRAPH_AGENTCORE=1: /invocations trusts SigV4 at the AgentCore edge. Never set it
# on a server behind a load balancer.
ENV_JSON=$(jq -n \
  --arg region "$REGION" \
  --arg store "$GRAPH_STORE" \
  '{
    FLOWGRAPH_AGENTCORE: "1",
    FLOWGRAPH_HOST: "0.0.0.0",
    FLOWGRAPH_PORT: "8080",
    FLOWGRAPH_GRAPH_STORE: $store,
    AWS_REGION: $region,
    AWS_DEFAULT_REGION: $region
  }')
for kv in "${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}"; do
  [[ "$kv" == *=* ]] || die "--env expects KEY=VALUE (got \"$kv\")"
  ENV_JSON=$(jq --arg k "${kv%%=*}" --arg v "${kv#*=}" '. + {($k): $v}' <<<"$ENV_JSON")
done

csv_json() { jq -cn --arg s "$1" '$s | split(",") | map(select(length > 0))'; }

if [[ -n "$SUBNETS" ]]; then
  NETWORK_JSON=$(jq -n --argjson subnets "$(csv_json "$SUBNETS")" --argjson sgs "$(csv_json "$SECURITY_GROUPS")" \
    '{networkMode: "VPC", networkModeConfig: {subnets: $subnets, securityGroups: $sgs}}')
else
  NETWORK_JSON='{"networkMode":"PUBLIC"}'
fi

if [[ -n "$SESSION_STORAGE" ]]; then
  FS_JSON=$(jq -n --arg p "$SESSION_STORAGE" '[{sessionStorage: {mountPath: $p}}]')
else
  FS_JSON='[]'
fi

# The body shared by create and update (both take the full desired configuration).
BODY=$(jq -n \
  --arg image "$IMAGE_URI" \
  --arg role "$ROLE_ARN" \
  --argjson network "$NETWORK_JSON" \
  --argjson env "$ENV_JSON" \
  --argjson fs "$FS_JSON" \
  --argjson idle "$IDLE_TIMEOUT" \
  --argjson life "$MAX_LIFETIME" \
  '{
    agentRuntimeArtifact: {containerConfiguration: {containerUri: $image}},
    roleArn: $role,
    networkConfiguration: $network,
    protocolConfiguration: {serverProtocol: "HTTP"},
    environmentVariables: $env,
    lifecycleConfiguration: {idleRuntimeSessionTimeout: $idle, maxLifetime: $life},
    description: "flowgraph-server"
  } + (if ($fs | length) > 0 then {filesystemConfigurations: $fs} else {} end)')

CTRL=(aws bedrock-agentcore-control --region "$REGION" --output json)

if (( DRY_RUN )); then
  echo "# create (when no runtime named $NAME exists):"
  jq --arg name "$NAME" '{agentRuntimeName: $name} + .' <<<"$BODY"
  echo "# update (when it exists): the same body with agentRuntimeId instead of agentRuntimeName"
  exit 0
fi

command -v aws >/dev/null || die "AWS CLI v2 is required"
"${CTRL[@]}" help >/dev/null 2>&1 \
  || die "this AWS CLI has no bedrock-agentcore-control commands; upgrade AWS CLI v2"

# Runtime ids are generated (<name>-<10 chars>), so look the runtime up by name.
find_runtime_id() {
  local token="" page id
  while :; do
    if [[ -n "$token" ]]; then
      page=$("${CTRL[@]}" list-agent-runtimes --max-results 100 --next-token "$token")
    else
      page=$("${CTRL[@]}" list-agent-runtimes --max-results 100)
    fi
    id=$(jq -r --arg n "$NAME" '.agentRuntimes[]? | select(.agentRuntimeName == $n) | .agentRuntimeId' <<<"$page" | head -n1)
    if [[ -n "$id" ]]; then echo "$id"; return; fi
    token=$(jq -r '.nextToken // empty' <<<"$page")
    [[ -n "$token" ]] || return 0
  done
}

RUNTIME_ID=$(find_runtime_id)
if [[ -n "$RUNTIME_ID" ]]; then
  echo "Updating AgentCore runtime $NAME ($RUNTIME_ID) in $REGION"
  RESULT=$("${CTRL[@]}" update-agent-runtime \
    --cli-input-json "$(jq --arg id "$RUNTIME_ID" '{agentRuntimeId: $id} + .' <<<"$BODY")")
else
  echo "Creating AgentCore runtime $NAME in $REGION"
  RESULT=$("${CTRL[@]}" create-agent-runtime \
    --cli-input-json "$(jq --arg name "$NAME" '{agentRuntimeName: $name} + .' <<<"$BODY")")
fi

RUNTIME_ID=$(jq -r '.agentRuntimeId' <<<"$RESULT")
RUNTIME_ARN=$(jq -r '.agentRuntimeArn' <<<"$RESULT")
echo "Runtime id:  $RUNTIME_ID"
echo "Runtime ARN: $RUNTIME_ARN"
echo "Version:     $(jq -r '.agentRuntimeVersion' <<<"$RESULT")"

if (( WAIT_SECONDS > 0 )); then
  deadline=$(( SECONDS + WAIT_SECONDS ))
  while :; do
    STATE=$("${CTRL[@]}" get-agent-runtime --agent-runtime-id "$RUNTIME_ID")
    status=$(jq -r '.status' <<<"$STATE")
    case "$status" in
      READY) echo "Status:      READY"; break ;;
      *_FAILED) die "runtime is $status: $(jq -r '.failureReason // "no reason given"' <<<"$STATE")" ;;
    esac
    (( SECONDS < deadline )) || die "still $status after ${WAIT_SECONDS}s; check: aws bedrock-agentcore-control get-agent-runtime --region $REGION --agent-runtime-id $RUNTIME_ID"
    echo "Status:      $status (waiting)"
    sleep 10
  done
fi

cat <<EOF

Next:
  export RUNTIME_ARN=$RUNTIME_ARN
  ./invoke.sh --region $REGION --runtime-arn "\$RUNTIME_ARN" --thread-id t1 start --yaml graph.yaml
Logs: CloudWatch log groups under /aws/bedrock-agentcore/runtimes/$RUNTIME_ID-*
EOF
