---
"@flowgraph/core": minor
---

Host limits for untrusted graphs: `CompileOptions.nodePolicy` (`{ blockedTypes, blockSubgraphFiles, blockSecrets, reason }`) refuses blocked node types (including `map` inners, agent skill tools and embedded subgraphs), subgraphs loaded from files, and `secrets.*` lookups while the graph is built and run, with `NodePolicyError` (`NODE_TYPE_BLOCKED`, `SUBGRAPH_FILE_BLOCKED`, `SECRET_REFERENCE_BLOCKED`). `CompileOptions.memoryIdentity` scopes the in-process and shared `ctx.store` of graphs without `runtime.memory`, so same-name graphs of different orgs or users stay apart. New `GraphNameRegistry` interface with `createInMemoryGraphNameRegistry` (first registrant of a name within an org owns it).
