---
"@flowgraph/core": patch
---

`validateSpec`, `compileGraph`, and `flowgraph validate` keep the schema diagnostics when a nested graph is malformed. A map body keeps those diagnostics, such as `Required`, for a hook field, a missing `edges` list, a node id or type, or an edge `from` or `to`. When that schema check fails, the nested lints are not run. A null node, a `nodes` value that is not a list, and a route or branch `when` that is not a string are reported as well.
