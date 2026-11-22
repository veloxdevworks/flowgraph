---
"@flowgraph/spec": major
"@flowgraph/core": major
---

Remove product nodes and `webhook` from `@flowgraph/spec` and `@flowgraph/core`, keeping the 14 core built-in node types (`agent`, `router`, `http`, `shell`, `script`, `function`, `skill`, `subgraph`, `map`, `hitl`, `wait`, `memory`, `mcp`, `fail`).

- Removed `demo`, `workshop`, `service`, `port`, `worktree`, `image`, `video`, `model3d`, `audio`, `kind: media`, and top-level `localTools` from `@flowgraph/spec` and `@flowgraph/core`; they now live in separately versioned preview packages under `@flowgraph/*` and register via `@flowgraph/spec` and `@flowgraph/core` extension hooks.
- Folded outbound `webhook` into `http` with `once: true` (idempotent via `ctx.once` with sensitive response header redaction) and removed the `webhook` node type. Run `flowgraph migrate` to rewrite existing `type: webhook` nodes.
