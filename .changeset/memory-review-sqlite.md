---
"@flowgraph/checkpoint-sqlite": minor
---

Memory schema migration 2 adds an op fingerprint column (`fg_memory_ops.fingerprint`). Thread bindings are insert-only, and `list` pushes its limit into SQL. Back up the `.db` file before upgrading; migrations are forward-only.
