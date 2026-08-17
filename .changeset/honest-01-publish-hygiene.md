---
"@veloxdevworks/flowgraph-core": patch
"@veloxdevworks/flowgraph-cli": patch
"@veloxdevworks/flowgraph-spec": patch
"@veloxdevworks/flowgraph-expr": patch
"@veloxdevworks/flowgraph-skills": patch
"@veloxdevworks/flowgraph-testing": patch
"@veloxdevworks/flowgraph-checkpoint-sqlite": patch
"@veloxdevworks/flowgraph-checkpoint-postgres": patch
"@veloxdevworks/flowgraph-observability-otel": patch
"@veloxdevworks/flowgraph-tools-fs": patch
"@veloxdevworks/flowgraph-provider-claude": patch
"@veloxdevworks/flowgraph-provider-cursor": patch
---

0.1 publish hygiene: restrict npm tarballs to `dist` + README + LICENSE, fail-fast when a graph requests `sqlite`/`postgres` without an injected checkpointer (subgraph embedding still passes `checkpointer: "none"`), and document the honest consumer surface (scoped CLI, unpublished TUI/MCP companions, `compiled.run` / `.resume` / `.continueRun` / `.stream`).
