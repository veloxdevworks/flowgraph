---
"@veloxdevworks/flowgraph-core": patch
---

Resolve subgraph YAML `imports` (reducers, nodes, providers) against the subgraph file's directory, not the parent graph directory. A child at `subgraphs/quality-gates.graph.yaml` with `{ reducers: ../register.ts }` now loads `register.ts` next to the parent graph.
