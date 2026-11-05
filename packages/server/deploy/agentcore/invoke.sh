#!/usr/bin/env bash
# Call a flowgraph-server AgentCore Runtime for one thread.
#
# AgentCore runs each runtime session in its own microVM, and a run lives in the
# memory of the microVM that started it. This script derives the session id from
# the thread id, so every call for a thread (start, events, cancel, resume, ...)
# reaches the same microVM. The response (SSE events) is written to stdout as
# the AWS CLI receives it, which may be in bursts rather than event by event;
# AWS CLI response metadata goes to stderr.
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
RUNTIME_ARN="${RUNTIME_ARN:-}"
THREAD_ID=""
YAML_FILE=""
INPUT_JSON=""
RESUME_JSON=""
AFTER_SEQ=""
NO_STREAM=0
SHOW_SESSION=0
ACTION=""

usage() {
  cat <<EOF
Usage: $0 --runtime-arn ARN --thread-id ID ACTION [options]

Actions:
  start     --yaml FILE [--input JSON]   start a run (streams until it ends or asks a human)
  resume    --resume JSON [--yaml FILE]  answer an interrupt and keep streaming
  events    [--after-seq N]              replay / follow the thread's events
  state | history | cancel | pause       control and inspection
  continue  [--yaml FILE]                continue a paused run

Options:
  --region R            AWS region (default: \$AWS_REGION or us-east-1)
  --runtime-arn ARN     runtime ARN printed by register.sh (or \$RUNTIME_ARN)
  --no-stream           start/resume: return the start result instead of streaming events
  --print-session-id    print the AgentCore session id for the thread and exit

The session id is "flowgraph-" + sha256(thread id). A thread whose microVM was stopped
(idle timeout, max lifetime, runtime update) comes back on a fresh one: the run's
in-memory state is gone, so resend --yaml with resume / continue.
EOF
  exit "${1:-1}"
}

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --runtime-arn) RUNTIME_ARN="$2"; shift 2 ;;
    --thread-id) THREAD_ID="$2"; shift 2 ;;
    --yaml) YAML_FILE="$2"; shift 2 ;;
    --input) INPUT_JSON="$2"; shift 2 ;;
    --resume) RESUME_JSON="$2"; shift 2 ;;
    --after-seq) AFTER_SEQ="$2"; shift 2 ;;
    --no-stream) NO_STREAM=1; shift ;;
    --print-session-id) SHOW_SESSION=1; shift ;;
    -h|--help) usage 0 ;;
    start|resume|events|state|history|cancel|pause|continue)
      [[ -z "$ACTION" ]] || die "only one action"
      ACTION="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$THREAD_ID" ]] || usage
command -v jq >/dev/null || die "jq is required"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}
SESSION_ID="flowgraph-$(printf '%s' "$THREAD_ID" | sha256)"

if (( SHOW_SESSION )); then echo "$SESSION_ID"; exit 0; fi
[[ -n "$ACTION" ]] || usage
[[ -n "$RUNTIME_ARN" ]] || die "--runtime-arn (or RUNTIME_ARN) is required"

PAYLOAD=$(jq -n --arg action "$ACTION" --arg threadId "$THREAD_ID" '{action: $action, threadId: $threadId}')
if [[ -n "$YAML_FILE" ]]; then
  [[ -f "$YAML_FILE" ]] || die "no such file: $YAML_FILE"
  PAYLOAD=$(jq --rawfile y "$YAML_FILE" '. + {yaml: $y}' <<<"$PAYLOAD")
fi
if [[ -n "$INPUT_JSON" ]]; then
  PAYLOAD=$(jq --argjson v "$INPUT_JSON" '. + {input: $v}' <<<"$PAYLOAD") || die "--input is not JSON"
fi
if [[ -n "$RESUME_JSON" ]]; then
  PAYLOAD=$(jq --argjson v "$RESUME_JSON" '. + {resume: $v}' <<<"$PAYLOAD") || die "--resume is not JSON"
fi
if [[ -n "$AFTER_SEQ" ]]; then
  [[ "$AFTER_SEQ" =~ ^[0-9]+$ ]] || die "--after-seq must be a number"
  PAYLOAD=$(jq --argjson n "$AFTER_SEQ" '. + {afterSeq: $n}' <<<"$PAYLOAD")
fi
(( NO_STREAM )) && PAYLOAD=$(jq '. + {stream: false}' <<<"$PAYLOAD")

case "$ACTION" in
  start) [[ -n "$YAML_FILE" ]] || die "start needs --yaml" ;;
  resume) [[ -n "$RESUME_JSON" ]] || die "resume needs --resume" ;;
esac

# The payload goes through a file: one command-line argument is capped at 128 KB
# on Linux, and graph YAML can be larger.
PAYLOAD_FILE=$(mktemp)
trap 'rm -f "$PAYLOAD_FILE"' EXIT
printf '%s' "$PAYLOAD" >"$PAYLOAD_FILE"

# The body goes to fd 3 (our stdout); the CLI's own JSON output (status code,
# session id) goes to stderr.
aws bedrock-agentcore invoke-agent-runtime \
  --no-cli-pager \
  --region "$REGION" \
  --agent-runtime-arn "$RUNTIME_ARN" \
  --runtime-session-id "$SESSION_ID" \
  --content-type application/json \
  --cli-binary-format raw-in-base64-out \
  --payload "file://$PAYLOAD_FILE" \
  /dev/fd/3 3>&1 1>&2
