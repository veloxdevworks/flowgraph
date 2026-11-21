---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

A `router` with `mode: model` requires `with.input`, and the model sees only that rendered text, the instruction and the routes. It no longer falls back to sending the whole graph state.

**What to change:** add `input:` to model routers that omit it, naming the text to route on, for example `input: "{{ state.request }}"`.
