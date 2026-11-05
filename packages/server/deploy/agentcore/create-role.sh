#!/usr/bin/env bash
# Create (or refresh) the IAM execution role an AgentCore Runtime assumes to run
# flowgraph-server: pull the image from ECR, write CloudWatch logs / X-Ray traces,
# and call Bedrock models. Follows the AgentCore Runtime execution-role policy in
# the AgentCore developer guide ("IAM Permissions for AgentCore Runtime").
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
ROLE_NAME="flowgraph-agentcore-runtime"
ECR_REPO="flowgraph-server"

usage() {
  cat <<EOF
Usage: $0 [--region R] [--role-name N] [--ecr-repo REPO]

Prints the role ARN to pass to register.sh --role-arn.
  --ecr-repo REPO   ECR repository the runtime pulls from (default: flowgraph-server)
EOF
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --role-name) ROLE_NAME="$2"; shift 2 ;;
    --ecr-repo) ECR_REPO="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

TRUST=$(jq -n --arg acct "$ACCOUNT" --arg region "$REGION" '{
  Version: "2012-10-17",
  Statement: [{
    Sid: "AssumeRolePolicy",
    Effect: "Allow",
    Principal: {Service: "bedrock-agentcore.amazonaws.com"},
    Action: "sts:AssumeRole",
    Condition: {
      StringEquals: {"aws:SourceAccount": $acct},
      ArnLike: {"aws:SourceArn": "arn:aws:bedrock-agentcore:\($region):\($acct):*"}
    }
  }]
}')

POLICY=$(jq -n --arg acct "$ACCOUNT" --arg region "$REGION" --arg repo "$ECR_REPO" '{
  Version: "2012-10-17",
  Statement: [
    {Sid: "ECRImageAccess", Effect: "Allow",
     Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
     Resource: ["arn:aws:ecr:\($region):\($acct):repository/\($repo)"]},
    {Sid: "ECRTokenAccess", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*"},
    {Sid: "Logs", Effect: "Allow",
     Action: ["logs:DescribeLogStreams", "logs:CreateLogGroup"],
     Resource: ["arn:aws:logs:\($region):\($acct):log-group:/aws/bedrock-agentcore/runtimes/*"]},
    {Sid: "LogGroups", Effect: "Allow", Action: ["logs:DescribeLogGroups"],
     Resource: ["arn:aws:logs:\($region):\($acct):log-group:*"]},
    {Sid: "LogEvents", Effect: "Allow",
     Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
     Resource: ["arn:aws:logs:\($region):\($acct):log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"]},
    {Sid: "Tracing", Effect: "Allow",
     Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"],
     Resource: "*"},
    {Sid: "Metrics", Effect: "Allow", Action: "cloudwatch:PutMetricData", Resource: "*",
     Condition: {StringEquals: {"cloudwatch:namespace": "bedrock-agentcore"}}},
    {Sid: "BedrockModelInvocation", Effect: "Allow",
     Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
     Resource: ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:\($acct):inference-profile/*"]}
  ]
}')

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role $ROLE_NAME exists; refreshing its trust and inline policies" >&2
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST"
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --description "flowgraph-server AgentCore Runtime execution role" \
    --assume-role-policy-document "$TRUST" >/dev/null
  echo "Created role $ROLE_NAME" >&2
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name flowgraph-agentcore-runtime --policy-document "$POLICY"

aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text
