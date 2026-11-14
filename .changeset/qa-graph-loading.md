---
"@flowgraph/core": minor
"@flowgraph/cli": patch
---

Reject cyclic graph imports with canonical source paths, resolve nested graph aliases and module imports relative to their declaring files, and validate missing imports, route targets, reachability, expression functions/depth, and channel defaults. Support tool-only and hook-only targets without dummy edges and show declared routes in CLI diagrams. Fix CLI validation of directory-containing graph paths.

Unreachable nodes now produce an error during validation and compilation rather than a warning. Remove unused nodes or declare their route/tool references. Child execution still inherits the parent's workspace unless the child declares its own runtime.workspace; resolving file references does not move execution into the graph directory.
