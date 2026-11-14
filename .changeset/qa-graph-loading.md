---
"@flowgraph/core": patch
"@flowgraph/cli": patch
---

Reject cyclic graph imports with canonical source paths, resolve nested graph aliases and module imports relative to their declaring files, and validate missing imports, route targets, reachability, expression functions/depth, and channel defaults. Support tool-only and hook-only targets without dummy edges and show declared routes in CLI diagrams. Fix CLI validation of directory-containing graph paths.
