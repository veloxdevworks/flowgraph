---
"@flowgraph/core": minor
"@flowgraph/checkpoint-sqlite": minor
"@flowgraph/checkpoint-postgres": minor
"@flowgraph/cli": minor
"@flowgraph/provider-claude": patch
"@flowgraph/provider-cursor": patch
"@flowgraph/provider-deepagents": patch
---

Persist completed agent/model/tool and shell steps by checkpoint task, refuse
uncertain external operations, and add replay inspection/reconciliation with
atomic receipt comparisons. Await replay writes in provider adapters. Scope
shell children as process groups for normal cancellation and require a separate
workspace for historical replay of side effects. Durable replay uses a separate
replay:1 schema; all workers sharing these threads must upgrade together.
