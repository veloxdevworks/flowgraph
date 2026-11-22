---
"@flowgraph/node-demo": minor
"@flowgraph/node-workshop": minor
"@flowgraph/node-service": minor
"@flowgraph/node-port": minor
"@flowgraph/node-worktree": minor
"@flowgraph/media": minor
"@flowgraph/tools-fs": minor
"@flowgraph/workshop-session": minor
"@flowgraph/cli": minor
"@flowgraph/server": patch
---

Introduce separately versioned preview packages for product nodes (`@flowgraph/node-demo`, `@flowgraph/node-workshop`, `@flowgraph/node-service`, `@flowgraph/node-port`, `@flowgraph/node-worktree`), move the four media node types (`image`, `video`, `model3d`, `audio`) and `kind: media` provider config into `@flowgraph/media`, and move the `localTools` graph schema extension into `@flowgraph/tools-fs`.

- `@flowgraph/cli` registers all preview product node packages by default so existing YAML graphs using those product nodes continue to run. Graphs that use the removed `type: webhook` node need to run `flowgraph migrate` first.
- `flowgraph migrate` rewrites legacy `type: webhook` nodes to `type: http` with `once: true` (and `method: POST` when omitted).
- `@flowgraph/server` keeps its untrusted upload policy blocking all moved host-capable node types (`service`, `worktree`, `demo`, `port`, `localTools`, and git-based `workshop` diffs).
