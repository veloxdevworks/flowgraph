---
"@flowgraph/spec": minor
---

One spelling for each output and reducer option, and projection-only output.

**BREAKING:**

- The `concat` reducer is removed. It behaved exactly like `append`; a channel that still uses it fails validation with a message pointing to `append`.
- A `none` key inside an output object is no longer supported, whatever its value (`{ none: true }`, `{ none: false }`, …). Write `output: none`. Any such key fails validation, and `none` together with `to` or `map` is rejected with its own message instead of silently writing nothing.

New:

- `output.raw` (and `collect.raw` on `map`): `raw: false` next to `to` / `map` writes only the projections and skips `state.outputs.<nodeId>`. `raw: false` without `to` or `map` is rejected; use `output: none` to write nothing.

**What to change:** replace `reducer: concat` with `reducer: append`, and an output object with a `none` key (such as `output: { none: true }`) with `output: none`.
