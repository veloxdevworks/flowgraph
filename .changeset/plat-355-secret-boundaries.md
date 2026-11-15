---
"@flowgraph/core": patch
---

Scope environment interpolation to parsed config/runtime values and support escaping. Mask observed secrets and sensitive HTTP header values in state, events, logs, checkpoints and replay snapshots; apply configured redaction patterns across those boundaries. Default logging to info so ordinary shell arguments are not printed at startup.

Node-body `${...}` expressions now remain literal; move load-time host settings into config/runtime. Short secrets are masked as whole values; longer secrets and explicit patterns also mask substrings. Console filtering does not suppress structured log events. Observed values are scoped to each invocation.
