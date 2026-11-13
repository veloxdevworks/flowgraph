---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/server": minor
---

`GraphSpecSchema` and `NodeSpecSchema` (including inline subgraph `spec:`) now reject unknown keys instead of silently stripping them, so a graph written for a newer flowgraph fails on an older engine instead of running without the new field. Graphs with unknown top-level or node keys now fail validation. `loadGraph` and the server `parseGraphYaml` report one `UNKNOWN_FIELD` error per key, with a "Did you mean" hint when a known key is within edit distance 2. `@flowgraph/spec` exports `diagnosticsFromZodIssues`, `editDistance` and `suggestKey`. `metadata`, `with`, `config` and `runtime` are unchanged.
