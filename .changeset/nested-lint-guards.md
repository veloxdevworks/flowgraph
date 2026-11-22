---
"@flowgraph/core": patch
---

`validateSpec`, `compileGraph`, and `flowgraph validate` keep the schema diagnostics when a nested graph is malformed, and skip the nested lints after that check fails. A map body keeps the schema message, such as `Required`. A top-level edge that names an unknown node includes the edge in the path, `edges[i]`.
