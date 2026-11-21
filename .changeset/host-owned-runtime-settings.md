---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/cli": patch
---

Settings that belong to the host are no longer accepted in a graph's `runtime` block. `runtime.hitl.onInterrupt` is rejected: the CLI's `--on-interrupt` or the `onInterrupt` run option decides how interrupts are answered, and a run without one uses `fail`. `runtime.observability`, `runtime.secrets.provider` and `runtime.checkpoint.namespace` are rejected too. Each error names what to use instead. `runtime.hitl.breakpoints` and `runtime.secrets.redact` are unchanged. `flowgraph init` no longer writes `runtime.observability`.

**What to change:** remove those fields from graph files. Pass `--on-interrupt` (or `onInterrupt` in `run()` / `resume()`) where a graph relied on `runtime.hitl.onInterrupt`; configure logging with `FLOWGRAPH_LOG_LEVEL` and event sinks; list credentials under the top-level `secrets:`.
