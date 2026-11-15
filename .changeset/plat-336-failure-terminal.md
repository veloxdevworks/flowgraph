---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/cli": patch
---

Add a first-class `fail` terminal with a rendered reason. Intentional failures
produce `FLOW_FAILED`, status `error`, and a nonzero CLI exit; they cannot be
retried or converted into success by node error policies. Failures propagate
through embedded graphs, map items, and agent tools.
