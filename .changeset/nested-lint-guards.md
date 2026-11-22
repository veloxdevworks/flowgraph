---
"@flowgraph/core": patch
---

`validateSpec`, `compileGraph`, and `flowgraph validate` report one coded diagnostic when a nested graph is malformed. A map body keeps the schema diagnostic, such as `Required`, for a hook field, a missing `edges` list, a node id or type, or an edge `from` or `to`. A null node, a `nodes` value that is not a list, and a route or branch `when` that is not a string are reported once as well.
