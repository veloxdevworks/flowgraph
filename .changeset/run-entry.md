---
"@flowgraph/core": minor
"@flowgraph/cli": patch
"@flowgraph/server": patch
---

Each start without a thread id is its own run, every entry point resolves graph inputs the same way, and a node's `input` is what its handler receives.

- `compiled.run()`, `stream()` and `prepare({ mode: "start" })` without `threadId` (or with an empty or whitespace-only one) get a fresh `runId` and thread (`thread-<runId>`) per call. Run ids have the shape `run-<uuid>` (from `crypto.randomUUID()`), so a default thread is `thread-run-<uuid>`; `compiled.runId` has the same shape. Before, every such call on one compiled graph reused the thread fixed at compile time, so checkpointed state, issues and budget usage carried over between unrelated runs. Events of that run carry the new `runId`. Calls on a caller-supplied thread, and `resume()` / `continueRun()` / `step()`, still report `compiled.runId`.
- New `resolveGraphInput(spec, provided)`: the graph's `input:` values, overlaid by the caller's, then `inputs:` defaults, coercion and required checks. `compiled.run()`, `stream()` and `prepare({ mode: "start" })` call it before anything runs, and the CLI and server use it too. A bad input rejects with `InputValidationError`, which now carries `code: "INPUT_INVALID"`.
- `function` handlers receive the node's `input` (or the model's tool arguments when the node is a tool) when `with.input` is not set; before, they received `{}`. `shell` sends the node's `input` as `FLOWGRAPH_INPUT` and stdin when `with.input` is not set. `with.input` still wins when present. `script` already behaved this way.

Migration:

- Code that called `run()` repeatedly without `threadId` to accumulate state on one thread must pass an explicit `threadId`. Code that read the default thread as `thread-${compiled.runId}` should read `result.threadId` instead.
- `compiled.run()` now rejects a missing required input or a wrongly typed one, and applies `inputs:` defaults and the graph's `input:` seed values, matching `flowgraph run`. Callers that relied on starting without required inputs must pass them or drop `required`.
- A `function` handler that ignored its argument is unaffected. One that reads its argument and was given only a node-level `input` now receives those values instead of `{}`. A `shell` node with a node-level `input` and no `with.input` now gets `FLOWGRAPH_INPUT` and stdin. An in-flight shell step checkpointed before this change, on such a node, is treated as a different call when it is replayed.
