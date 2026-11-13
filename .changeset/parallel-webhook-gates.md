---
"@flowgraph/core": patch
"@flowgraph/cli": patch
---

Isolate webhook callbacks by thread, node, and interrupt id. Each callback resumes
only its intended gate, preserves waiting siblings, and serializes checkpoint
writes with other callbacks in the same process. State inspection and durable
recovery no longer recreate answered gates from stale interrupt writes.

Generated callback URLs include the interrupt id. Legacy node-only URLs remain
usable when they identify one registration and return 409 when ambiguous. The CLI
prints every pending callback URL and continues listening after partial replies.
