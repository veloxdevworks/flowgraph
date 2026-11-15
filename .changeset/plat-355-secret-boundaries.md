---
"@flowgraph/core": patch
---

Scope environment interpolation to parsed config/runtime values and support escaping. Mask observed secrets and sensitive HTTP header values in state, events, logs, checkpoints and replay snapshots; apply configured redaction patterns across those boundaries. Default logging to info so ordinary shell arguments are not printed at startup.
