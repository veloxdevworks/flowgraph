---
"@flowgraph/core": minor
---

Add `NodeCapabilities.hostAccess`, `registry.isUntrustedSafe()`, and `NodePolicy.requireSafeNodeTypes`. Node types default to `hostAccess: true` so untrusted policies operate in allowlist mode, and `requireSafeNodeTypes: true` implies `blockHostExec`.
