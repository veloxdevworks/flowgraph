---
"@flowgraph/core": minor
---

`demo` can prove an objective (ADR-0019, slice 3). A `steps` flow runs against `target.web`, checks assertions, and is the only mode that can reach `passed`.

- New step verbs `goto`, `click`, `fill`, `press`, `wait`, `screenshot` and `expect` (`text`, `visible`, `url`, `hidden`), plus `with.expect.noConsoleErrors`. Negative checks alone are `inconclusive`.
- A flow is always recorded and always ends with a screenshot, on failure as well. Results gain `objective`, `steps`, `assertions` and `console`, `null` when they don't apply.
- `with.objective` is also allowed on the shorthand modes, which stay `inconclusive` at best. With an objective, `strict` throws unless the status is `passed`. A `failed` result with an objective raises `OBJECTIVE_FAILED`.
- A `demo` node with `objective` or `steps` can't be an agent tool (`DEMO_OBJECTIVE_AS_TOOL`).
- Fixes `screenshot: { video: true }` recordings that were a second of blank white: the capture now holds on the loaded page, which adds just under a second.
- An iOS recording under half of `duration` now raises a warning: `simctl` writes frames only when the screen changes, so a still screen gives a single frame.
