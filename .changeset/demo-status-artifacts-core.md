---
"@flowgraph/core": minor
---

`demo` results gain a `status` and move onto the `Artifact` contract (ADR-0019, slice 1). Graphs that don't read the new fields behave the same apart from the breaking changes below.

**BREAKING:**

- **Files move.** Every `demo` mode now writes under `.flowgraph/artifacts/<threadId|runId>/<nodeId>/`, where media nodes write theirs, instead of `.flowgraph/demo/<nodeId>/`. Anything that hard-codes the old folder stops finding new captures. Files from earlier runs are not moved. The manifest stays at `.flowgraph/demo/runs/<key>/manifest.jsonl`.
- **Absent fields are `null`.** Every result field is written on every run, `null` when absent (`path`, `mimeType`, `sizeBytes`, `reason`, `label`, `extra`, `pageStatus`, `request`, `response`), where they were left out. A check like `path === undefined` now needs `path == null`. `outputs` is deep-merged, so a capture that succeeded and then failed on a loop-back used to return `ok: false` with the first run's `path`, and a gate would show that old file.

Additions:

- `status`: `inconclusive` for a capture that worked, `failed` for one that recorded a failure (an HTTP status outside `expect.status`, by default 400 or above; the file is kept), `not_captured` when nothing was captured. `ok` is derived and unchanged: true for `inconclusive`, false for the others. `passed` exists but no mode produces it yet.
- `artifacts`: `Artifact` records with workspace-relative paths, `sha256`, `mimeType` and `role`, main file first. `path` and `extra` stay as they were.
- Manifest entries gain `status` and `artifacts`. Entries written before this get a `status` derived from `ok` and `path` when read.
- A gate lists a `demo` failure even when the output also has `artifacts`. The new field would otherwise have hidden failures from `with.artifacts`.
- A capture that fails after the browser opened no longer leaves a half-written screenshot or recording among the artifacts.
