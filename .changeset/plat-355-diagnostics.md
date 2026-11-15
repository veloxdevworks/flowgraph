---
"@flowgraph/core": patch
"@flowgraph/cli": patch
"@flowgraph/spec": patch
"@flowgraph/media": patch
---

Preserve typed node/run error codes and emit JSON error events for CLI admission failures. Name script nodes and valid provider stop reasons, report media token usage, avoid shell-execution logs for refused replay steps, and emit run.start for continuations. Add nested-field validation hints, outcome labels in topology and path/startup documentation.
