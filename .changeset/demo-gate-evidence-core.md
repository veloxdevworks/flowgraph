---
"@flowgraph/core": minor
"@flowgraph/cli": minor
---

`hitl` gates can name the `demo` evidence they need (ADR-0019, slice 4).

- `with.evidence` lists `demo` node ids. The gate sends `data.evidence` with each node's verdict, reports a node that never ran as `not_run`, adds the files to `artifacts`, and appends the verdicts to the message.
- In `approve` and `review`, approving past evidence that is `failed`, `not_captured`, `not_run` or whose files are gone needs `override: { reason }`, or the gate re-prompts. The output gains `override` (`null` when unused), and an accepted override raises `EVIDENCE_OVERRIDDEN`. `--on-interrupt approve` can no longer wave past such evidence.
- Lint and compile refuse ids that aren't `demo` nodes with an `objective` and stored output.
- The CLI prompt says when an override is needed and accepts `override: <reason>`.
