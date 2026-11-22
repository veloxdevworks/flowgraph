---
"@flowgraph/server": minor
---

Enforce a default-deny allowlist for untrusted graph uploads based on node type `hostAccess` capabilities. Operator-registered plugin node types are now refused for untrusted users unless explicitly registered with `capabilities: { hostAccess: false }`. Also reject absolute, `~`, and `..` paths in media node `input`/`inputs` (including `{ artifact }` and `{ artifacts }` wrappers).
