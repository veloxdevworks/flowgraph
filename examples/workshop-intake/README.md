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

### Interactive (terminal)

On a real terminal, `--on-interrupt prompt` runs a guided session instead of asking for pasted JSON:

```bash
$CLI run workshop-intake.graph.yaml --thread intake-3 --on-interrupt prompt
```

You pick how to take part: `form` (confirm each agenda item, then fill `title`, `acceptance`, `risks`; Enter skips an optional field; arrays take one item per line and a blank line ends the list) or `json` (the paste-JSON prompt). Skip an agenda item and answer `fix` when the engine rule rejects it to see only the failing part re-asked; `end` finishes early as `human_ended`, which this graph allows (`allowPartial`).

For a chat with an AI facilitator, configure a model (the id is yours to choose) and the vendor's key, then pick `chat` (it becomes the default):

```bash
export FLOWGRAPH_WORKSHOP_MODEL=anthropic:<model-id>   # or openai:<model-id>, xai:<model-id>
export ANTHROPIC_API_KEY=...                           # OPENAI_API_KEY / XAI_API_KEY (or GROK_API_KEY)
$CLI run workshop-intake.graph.yaml --thread intake-4 --on-interrupt prompt
```

In chat: `/status`, `/draft`, `/form`, `/end`, `/json`. With piped stdin (no TTY) the prompt stays paste-JSON.

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
