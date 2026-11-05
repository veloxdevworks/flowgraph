# workshop-intake

A `workshop` node run **headless**, with no LLM and no network. It shows the
engine options from ADR-0018:

- `requireCoverage: true`: a session reported as `completed` is rejected (and
  re-prompted with a `validationError`) while an agenda item is uncovered.
- `allowPartial: true`: a session that ends early (`human_ended`, `timeout`,
  `skipped`) is still accepted, with `complete: false`.
- `transcript: omit`: the transcript is not written to state or `node.output`.

```
START -> intake (workshop) -> route (router on brief.complete) -> END
                                   \-> follow-up (hitl approve) -> END
```

The graph checkpoints to `.flowgraph/workshop-intake.db` (sqlite), so a
separate `flowgraph resume` process can pick the thread up. Without a
persistent checkpoint backend the interrupt is gone when the first process exits.

## Run it

From this directory (use `flowgraph` instead of `node ../../packages/cli/dist/bin.js`
if the CLI is on your PATH):

```bash
CLI="node ../../packages/cli/dist/bin.js"

$CLI validate workshop-intake.graph.yaml

# 1. Start; `--on-interrupt fail` stops at the workshop and exits with code 3.
$CLI run workshop-intake.graph.yaml --thread intake-1 --on-interrupt fail

# 2. Inspect the session contract (agenda, schema, requireCoverage, ...).
$CLI resume workshop-intake.graph.yaml --thread intake-1 --list --json

# 3a. Uncovered agenda items: rejected, the workshop interrupt is re-issued
#     with a validationError (exit 3).
$CLI resume workshop-intake.graph.yaml --thread intake-1 \
  --resume "$(cat resume.uncovered.example.json)"

# 3b. Everything covered: completes, state.brief.complete is true (exit 0).
$CLI resume workshop-intake.graph.yaml --thread intake-1 \
  --resume "$(cat resume.example.json)"
```

An early end, on a second thread:

```bash
$CLI run workshop-intake.graph.yaml --thread intake-2 --on-interrupt fail
# Accepted despite the missing items; complete is false, so the router sends it
# to follow-up, which pauses for approval.
$CLI resume workshop-intake.graph.yaml --thread intake-2 \
  --resume "$(cat resume.partial.example.json)"
$CLI resume workshop-intake.graph.yaml --thread intake-2 --resume '{"approved":true}'
```

Add `--json` to a resume to see the final state in the `run.end` event. State
has `brief: { output, coverage, endedReason, complete }` and no `transcript`.

Delete `.flowgraph/` to start over. A real client (voice or text) builds the
same `{ output, transcript, coverage, endedReason }` value itself; see
`docs/adr/0018-workshop-controller-and-facilitators.md`.
