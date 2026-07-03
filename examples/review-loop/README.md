# Review loop

Draft content, pause for human review, revise on rejection, and loop until approved.

## Setup

None — zero API keys; uses registered `code` functions.

```bash
pnpm install
```

## Run

```bash
pnpm start
# or: flowgraph run review-loop.graph.yaml --stream --on-interrupt prompt --thread review-loop
```

## Flow

1. **`write-draft`** — writes `state.draft` from `state.topic` and `state.revision`
2. **`review`** — `hitl` approve gate; result in `state.approval`
3. **Branch** — approved → `finalize`; rejected → `revise` → back to `review`
4. **`finalize`** — writes `state.final` when approved

## Resume

After the first interrupt:

```bash
flowgraph resume review-loop.graph.yaml --thread review-loop --resume '{"approved":false}'
# loops: revise → draft → review again

flowgraph resume review-loop.graph.yaml --thread review-loop --resume '{"approved":true}'
# completes with state.final set
```

## Highlights

- Conditional branching after HITL
- Cyclic control flow (reject → revise → draft → review)
- Durable checkpointing (`runtime.checkpoint`)
